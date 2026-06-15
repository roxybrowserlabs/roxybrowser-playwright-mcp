import { resolveRoxyBrowserFirefoxBidiEndpoint } from "./roxybrowser-firefox-bidi.mjs";

const endpoint = await resolveRoxyBrowserFirefoxBidiEndpoint({ debug: true });
console.log(endpoint);
