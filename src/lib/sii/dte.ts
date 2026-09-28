import { SignedXml } from "xml-crypto";
import { parseRut } from "@/lib/rut";

export type SiiEnvironment = "certification" | "production";
export type SiiDteAction = "CNS" | "ACD" | "ERM" | "RCD" | "RFP" | "RFT";

export type SiiResponse = { code: number | null; message: string | null; raw: string };

const SII_NAMESPACE = "http://ws.registroreclamodte.diii.sdi.sii.cl";

function decodeXml(value: string) {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

function escapeXml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function tag(xml: string, name: string) {
  const match = xml.match(new RegExp(`<(?:(?:\\w+):)?${name}[^>]*>([\\s\\S]*?)</(?:(?:\\w+):)?${name}>`, "i"));
  return match ? decodeXml(match[1].trim()) : null;
}

function soap(body: string) {
  return `<?xml version="1.0" encoding="UTF-8"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:SOAP-ENC="http://schemas.xmlsoap.org/soap/encoding/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" SOAP-ENV:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><SOAP-ENV:Body>${body}</SOAP-ENV:Body></SOAP-ENV:Envelope>`;
}

function pem(value: string | undefined) {
  return value?.replace(/\\n/g, "\n").trim() || null;
}

function endpoints(environment: SiiEnvironment) {
  const host = environment === "production" ? "palena.sii.cl" : "maullin.sii.cl";
  const complaintHost = environment === "production" ? "ws1.sii.cl/WSREGISTRORECLAMODTE" : "ws2.sii.cl/WSREGISTRORECLAMODTECERT";
  return {
    seed: `https://${host}/DTEWS/CrSeed.jws`,
    token: `https://${host}/DTEWS/GetTokenFromSeed.jws`,
    authenticationNamespace: `https://${host}/DTEWS`,
    registry: `https://${complaintHost}/registroreclamodteservice`,
  };
}

export { parseRut };

async function postXml(url: string, body: string, token?: string) {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        SOAPAction: '""',
        ...(token ? { Cookie: `TOKEN=${token}` } : {}),
      },
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(25_000),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") throw new Error("sii_network_timeout");
    throw new Error("sii_network_unavailable");
  }
  const raw = await response.text();
  if (!response.ok) throw new Error(`sii_http_${response.status}`);
  if (/<(?:\w+:)?Fault\b/i.test(raw)) throw new Error(`sii_soap_fault:${tag(raw, "faultstring") ?? "unknown"}`);
  return raw;
}

function signSeed(seed: string, privateKey: string, certificate: string) {
  const unsigned = `<getToken><item><Semilla>${escapeXml(seed)}</Semilla></item></getToken>`;
  const signer = new SignedXml({
    privateKey,
    publicCert: certificate,
    signatureAlgorithm: "http://www.w3.org/2000/09/xmldsig#rsa-sha1",
    canonicalizationAlgorithm: "http://www.w3.org/TR/2001/REC-xml-c14n-20010315",
  });
  signer.addReference({
    xpath: "//*[local-name(.)='getToken']",
    transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature"],
    digestAlgorithm: "http://www.w3.org/2000/09/xmldsig#sha1",
    isEmptyUri: true,
  });
  signer.computeSignature(unsigned);
  return signer.getSignedXml();
}

export async function getSiiToken(environment: SiiEnvironment) {
  return token(environment);
}

async function token(environment: SiiEnvironment) {
  const privateKey = pem(process.env.SII_PRIVATE_KEY_PEM);
  const certificate = pem(process.env.SII_CERTIFICATE_PEM);
  if (!privateKey || !certificate) throw new Error("sii_certificate_not_configured");
  const urls = endpoints(environment);
  const seedResponse = await postXml(urls.seed, soap(`<m:getSeed xmlns:m="${urls.authenticationNamespace}/CrSeed.jws"/>`));
  const seedPayload = tag(seedResponse, "getSeedReturn");
  const seed = seedPayload ? tag(seedPayload, "SEMILLA") : null;
  if (!seed) throw new Error("sii_seed_unavailable");
  const signedSeed = signSeed(seed, privateKey, certificate);
  const tokenResponse = await postXml(urls.token, soap(`<m:getToken xmlns:m="${urls.authenticationNamespace}/GetTokenFromSeed.jws"><pszXml>${escapeXml(signedSeed)}</pszXml></m:getToken>`));
  const tokenPayload = tag(tokenResponse, "getTokenReturn");
  const value = tokenPayload ? tag(tokenPayload, "TOKEN") : null;
  if (!value) throw new Error("sii_token_unavailable");
  return value;
}

async function invoke(environment: SiiEnvironment, operation: string, issuerRut: string, documentType: number, folio: number, action?: SiiDteAction) {
  const issuer = parseRut(issuerRut);
  if (!issuer || ![33, 34, 43].includes(documentType) || !Number.isSafeInteger(folio) || folio <= 0) throw new Error("invalid_sii_dte_identity");
  const operationBody = `<m:${operation} xmlns:m="${SII_NAMESPACE}"><rutEmisor>${issuer.body}</rutEmisor><dvEmisor>${issuer.dv}</dvEmisor><tipoDoc>${documentType}</tipoDoc><folio>${folio}</folio>${action ? `<accionDoc>${action}</accionDoc>` : ""}</m:${operation}>`;
  const raw = await postXml(endpoints(environment).registry, soap(operationBody), await token(environment));
  const codeText = tag(raw, "codResp") ?? tag(raw, "codigo") ?? tag(raw, "return");
  const message = tag(raw, "descResp") ?? tag(raw, "descripcion") ?? tag(raw, "glosa") ?? null;
  const code = codeText && /^-?\d+$/.test(codeText) ? Number(codeText) : null;
  return { code, message, raw } satisfies SiiResponse;
}

export const siiDte = {
  registerAction: (environment: SiiEnvironment, issuerRut: string, documentType: number, folio: number, action: Exclude<SiiDteAction, "CNS">) => invoke(environment, "ingresarAceptacionReclamoDoc", issuerRut, documentType, folio, action),
  listEvents: (environment: SiiEnvironment, issuerRut: string, documentType: number, folio: number) => invoke(environment, "listarEventosHistDoc", issuerRut, documentType, folio),
  receptionDate: (environment: SiiEnvironment, issuerRut: string, documentType: number, folio: number) => invoke(environment, "consultarFechaRecepcionSii", issuerRut, documentType, folio),
};
