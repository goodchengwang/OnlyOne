// Replaced at compile time for onlyonecli platform packages.
declare const ONLYONE_BUILD_VERSION: string;
export const CLI_VERSION = typeof ONLYONE_BUILD_VERSION === "undefined" ? "dev" : ONLYONE_BUILD_VERSION;
export const npmBuild = CLI_VERSION !== "dev";
export const displayRev = (rev?: string) => rev && /^\d+\.\d+\.\d+(?:-|$)/.test(rev) ? rev : rev?.slice(0, 7);
