export const scrub = (text: string) => text.replace(/api_key=[^&]+/g, 'api_key=<redacted>')
