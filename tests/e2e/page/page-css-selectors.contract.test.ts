import { describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";

describe("page CSS selector contract e2e", () => {
  it("matches querySelectorAll counts on a large DOM like Playwright", async () => {
    await withPage(async (page) => {
      await page.evaluate(() => {
        let id = 0;
        const next = (tag: string) => {
          const element = document.createElement(tag);
          const eid = ++id;
          element.textContent = `id${eid}`;
          element.id = String(eid);
          return element;
        };
        const generate = (depth: number): HTMLDivElement => {
          const div = next("div") as HTMLDivElement;
          const span1 = next("span");
          const span2 = next("span");
          div.appendChild(span1);
          div.appendChild(span2);
          if (depth > 0) {
            div.appendChild(generate(depth - 1));
            div.appendChild(generate(depth - 1));
          }
          return div;
        };
        document.body.appendChild(generate(10));
      });

      const selectors = [
        "div div div span",
        "div > div div > span",
        "div + div div div span + span",
        "div ~ div div > span ~ span",
        "div > div > div + div > div + div > span ~ span",
        "div div div div div div div div div div span",
        "div > div > div > div > div > div > div > div > div > div > span",
        "div ~ div div ~ div div ~ div div ~ div div ~ div span",
        "span"
      ];

      for (const selector of selectors) {
        const playwrightCount = await page.$$eval(selector, (elements) => elements.length);
        const nativeCount = await page.evaluate(
          (selectorText) => document.querySelectorAll(selectorText).length,
          selector
        );
        expect(playwrightCount).toBe(nativeCount);
      }
    });
  });

  it("supports child combinator spacing like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent(`<div foo="bar" bar="baz"><span></span></div>`);

      const selectors = [
        `div[foo="bar"] > span`,
        `div[foo="bar"]> span`,
        `div[foo="bar"] >span`,
        `div[foo="bar"]>span`,
        `div[foo="bar"]   >    span`,
        `div[foo="bar"]>    span`,
        `div[foo="bar"]     >span`,
        `div[foo="bar"][bar="baz"] > span`,
        `div[foo="bar"][bar="baz"]> span`,
        `div[foo="bar"][bar="baz"] >span`,
        `div[foo="bar"][bar="baz"]>span`,
        `div[foo="bar"][bar="baz"]   >    span`,
        `div[foo="bar"][bar="baz"]>    span`,
        `div[foo="bar"][bar="baz"]     >span`
      ];

      for (const selector of selectors) {
        expect(await page.$eval(selector, (element) => element.outerHTML)).toBe("<span></span>");
      }
    });
  });

  it("keeps DOM order with comma separated selectors like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent(`<section><span><div><x></x><y></y></div></span></section>`);

      expect(await page.$$eval(`css=span,div`, (elements) => elements.map((element) => element.nodeName).join(","))).toBe("SPAN,DIV");
      expect(await page.$$eval(`css=div,span`, (elements) => elements.map((element) => element.nodeName).join(","))).toBe("SPAN,DIV");
      expect(await page.$$eval(`css=span div, div`, (elements) => elements.map((element) => element.nodeName).join(","))).toBe("DIV");
      expect(await page.$$eval(`css=span,div >> css=x,y`, (elements) => elements.map((element) => element.nodeName).join(","))).toBe("X,Y");
      expect(await page.$$eval(`css=div >> css=x,y`, (elements) => elements.map((element) => element.nodeName).join(","))).toBe("X,Y");
      expect(await page.$$eval(`css=section >> css=div,span >> css=x,y`, (elements) => elements.map((element) => element.nodeName).join(","))).toBe("X,Y");
    });
  });

  it("supports attribute selectors containing commas and selector separators like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent(`<div attr="hello world" attr2="hello-''>>foo=bar[]" attr3="] span"><span></span></div>`);
      await page.evaluate(() => {
        (window as Window & { div?: Element }).div = document.querySelector("div") ?? undefined;
      });

      const selectors = [
        `[attr="hello world"]`,
        `[attr = "hello world"]`,
        `[attr ~= world]`,
        `[attr ^=hello ]`,
        `[attr $= world ]`,
        `[attr *= "llo wor" ]`,
        `[attr2 |= hello]`,
        `[attr = "Hello World" i ]`,
        `[attr *= "llo WOR"i]`,
        `[attr $= woRLD i]`,
        `[attr2 = "hello-''>>foo=bar[]"]`,
        `[attr2 $="foo=bar[]"]`
      ];

      for (const selector of selectors) {
        expect(await page.$eval(selector, (element) => element === (window as Window & { div?: Element }).div)).toBe(true);
      }
      expect(await page.$eval(`[attr*=hello] span`, (element) => element.parentNode === (window as Window & { div?: Element }).div)).toBe(true);
      expect(await page.$eval(`[attr*=hello] >> span`, (element) => element.parentNode === (window as Window & { div?: Element }).div)).toBe(true);
      expect(await page.$eval(`[attr3="] span"] >> span`, (element) => element.parentNode === (window as Window & { div?: Element }).div)).toBe(true);

      await page.setContent(`<span></span><div attr="hello,world!"></div>`);
      expect(await page.$eval(`css=div[attr="hello,world!"]`, (element) => element.outerHTML)).toBe('<div attr="hello,world!"></div>');
      expect(await page.$eval(`css=[attr="hello,world!"]`, (element) => element.outerHTML)).toBe('<div attr="hello,world!"></div>');
      expect(await page.$eval(`css=div[attr='hello,world!']`, (element) => element.outerHTML)).toBe('<div attr="hello,world!"></div>');
      expect(await page.$eval(`css=[attr='hello,world!']`, (element) => element.outerHTML)).toBe('<div attr="hello,world!"></div>');
      expect(await page.$eval(`css=div[attr="hello,world!"],span`, (element) => element.outerHTML)).toBe("<span></span>");
    });
  });
});
