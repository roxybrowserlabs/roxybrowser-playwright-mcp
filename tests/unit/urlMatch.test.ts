import { describe, expect, it } from "vitest";
import { globToRegexPattern, resolveGlobToRegexPattern, urlMatches } from "../../src/urlMatch.js";

describe("urlMatch parity", () => {
  it("matches Playwright glob semantics", () => {
    const globToRegex = (glob: string): RegExp => new RegExp(globToRegexPattern(glob));

    expect(globToRegex("**/*.js").test("https://localhost:8080/foo.js")).toBe(true);
    expect(globToRegex("**/*.css").test("https://localhost:8080/foo.js")).toBe(false);
    expect(globToRegex("*.js").test("https://localhost:8080/foo.js")).toBe(false);
    expect(globToRegex("https://**/*.js").test("https://localhost:8080/foo.js")).toBe(true);
    expect(globToRegex("**/{a,b}.js").test("https://localhost:8080/a.js")).toBe(true);
    expect(globToRegex("**/{a,b}.js").test("https://localhost:8080/b.js")).toBe(true);
    expect(globToRegex("**/{a,b}.js").test("https://localhost:8080/c.js")).toBe(false);
    expect(globToRegex("**/*.{png,jpg,jpeg}").test("https://localhost:8080/c.jpg")).toBe(true);
    expect(globToRegex("foo*").test("foo.js")).toBe(true);
    expect(globToRegex("foo*").test("foo/bar.js")).toBe(false);
    expect(globToRegex("**/api\\?param").test("http://example.com/api?param")).toBe(true);
    expect(globToRegex("**/api\\?param").test("http://example.com/api-param")).toBe(false);
    expect(globToRegex("\\?")).toEqual(/^\?$/);
    expect(globToRegex("\\[")).toEqual(/^\[$/);
    expect(globToRegex("[a-z]")).toEqual(/^\[a-z\]$/);
  });

  it("throws on unbalanced glob braces like Playwright", () => {
    expect(() => globToRegexPattern("{foo")).toThrow(`Invalid glob pattern "{foo": unmatched '{'`);
    expect(() => globToRegexPattern("}foo")).toThrow(`Invalid glob pattern "}foo": unmatched '}'`);
    expect(() => globToRegexPattern("http://*/foo{")).toThrow("unmatched '{'");
    expect(() => globToRegexPattern("**/*.png?{")).toThrow("unmatched '{'");
    expect(() => globToRegexPattern("https://example.com/{a")).toThrow("unmatched '{'");
    expect(() => globToRegexPattern("{{foo}")).toThrow("nested '{' is not supported");
    expect(() => globToRegexPattern("\\{foo")).not.toThrow();
    expect(() => globToRegexPattern("foo\\}")).not.toThrow();
  });

  it("resolves baseURL and matches URLs like Playwright", () => {
    expect(urlMatches(undefined, "http://playwright.dev/", "http://playwright.dev")).toBe(true);
    expect(urlMatches(undefined, "http://playwright.dev/?a=b", "http://playwright.dev?a=b")).toBe(true);
    expect(urlMatches(undefined, "http://playwright.dev/", "h*://playwright.dev")).toBe(true);
    expect(urlMatches(undefined, "http://api.playwright.dev/?x=y", "http://*.playwright.dev?x=y")).toBe(true);
    expect(urlMatches(undefined, "http://playwright.dev/foo/bar", "**/foo/**")).toBe(true);
    expect(urlMatches("http://playwright.dev", "http://playwright.dev/?x=y", "?x=y")).toBe(true);
    expect(urlMatches("http://playwright.dev/foo/", "http://playwright.dev/foo/bar?x=y", "./bar?x=y")).toBe(true);
    expect(urlMatches(undefined, "https://playwright.dev/foobar", "https://playwright.dev/fooBAR")).toBe(false);
    expect(urlMatches(undefined, "https://localhost:3000/?a=b", "**/?a=b")).toBe(true);
    expect(urlMatches(undefined, "https://localhost:3000/?a=b", "**?a=b")).toBe(true);
    expect(urlMatches(undefined, "my.custom.protocol://foo", "my.custom.protocol://**")).toBe(true);
    expect(urlMatches(undefined, "file:///foo/", "f*e://**")).toBe(true);
  });

  it("supports websocket baseURL translation", () => {
    expect(resolveGlobToRegexPattern("https://example.com/base/", "./socket", true)).toBe(
      globToRegexPattern("wss://example.com/base/socket")
    );
  });
});
