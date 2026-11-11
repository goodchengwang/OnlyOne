// The Worker's text language: ONLYONE_LANG (copied from [owner] language by `onlyone cloud deploy`); "en" gives English,
// anything else Simplified Chinese. The env never changes within an isolate, so setting it per entry point is safe.
let en = false;
export const setLang = (lang?: string) => { en = /^en/i.test(lang ?? ""); };
export const L = (english: string, zh: string): string => (en ? english : zh);
