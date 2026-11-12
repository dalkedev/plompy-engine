export class LocalError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const descriptions = {
  AUTH_REQUIRED: 'Integration needs a valid private credential or supported authentication mode.',
  AUTH_REJECTED: 'The integration rejected its credential. Replace it through the local CLI.',
  RATE_LIMITED: 'The integration is rate limited. No automatic retry was made.',
  TIMEOUT: 'The operation timed out or was cancelled. No automatic retry was made.',
  UNAVAILABLE: 'The integration could not complete this operation. Check its explicit live diagnostic.',
  UNSUPPORTED: 'This integration or authentication mode is not supported in the local research profile.',
  INVALID_INPUT: 'Tool input does not match its schema or allowed public destination.',
  LIMIT: 'The operation exceeded a configured size or concurrency limit.',
  SECRET: 'The request contains a configured credential and was rejected.',
  ARTIFACT: 'Artifact operation refused. Use a flat filename in the artifact directory and do not replace unrelated files.',
};
export function safeError(error) {
  const mapped={URL_BLOCKED:'INVALID_INPUT',METHOD_BLOCKED:'INVALID_INPUT',HEADER_BLOCKED:'INVALID_INPUT',FETCH_CANCELLED:'TIMEOUT',BROWSER_CANCELLED:'TIMEOUT',BROWSER_BUSY:'LIMIT',RESPONSE_TOO_LARGE:'LIMIT'};
  const code = Object.hasOwn(descriptions, error?.code) ? error.code : mapped[error?.code] ?? 'UNAVAILABLE';
  return { code, message: descriptions[code] };
}
