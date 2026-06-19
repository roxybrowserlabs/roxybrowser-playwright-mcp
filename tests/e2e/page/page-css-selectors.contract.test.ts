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
      expect(await page.$$eval(`*css=section >> css=div,span`, (elements) => elements.map((element) => element.nodeName).join(","))).toBe("SECTION");
      expect(await page.$$eval(`css=section >> *css=div >> css=x,y`, (elements) => elements.map((element) => element.nodeName).join(","))).toBe("DIV");
      expect(await page.$$eval(`css=section >> *css=div,span >> css=x,y`, (elements) => elements.map((element) => element.nodeName).join(","))).toBe("SPAN,DIV");
      expect(await page.$$eval(`css=section >> *css=div,span >> css=y`, (elements) => elements.map((element) => element.nodeName).join(","))).toBe("SPAN,DIV");
      expect(await page.$$eval(`css=span,div >> css=x,y`, (elements) => elements.map((element) => element.nodeName).join(","))).toBe("X,Y");
      expect(await page.$$eval(`css=div >> css=x,y`, (elements) => elements.map((element) => element.nodeName).join(","))).toBe("X,Y");
      expect(await page.$$eval(`css=section >> css=div,span >> css=x,y`, (elements) => elements.map((element) => element.nodeName).join(","))).toBe("X,Y");
    });
  });

  it("returns multiple captures for the same node like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent(`<div><div><div><span></span></div></div></div>`);

      expect(await page.$$eval(`*css=div >> span`, (elements) => elements.map((element) => element.nodeName).join(","))).toBe("DIV,DIV,DIV");
    });
  });

  it("returns multiple captures when going up the hierarchy like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent(`<section>Hello<ul><li></li><li></li></ul></section>`);

      expect(await page.$$eval(`*css=li >> ../.. >> text=Hello`, (elements) => elements.map((element) => element.nodeName).join(","))).toBe("LI,LI");
    });
  });

  it("supports comma separated selector lists in various positions like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent(`<section><span><div><x></x><y></y></div></span></section>`);

      expect(await page.$$eval(`css=span,div >> css=x,y`, (elements) => elements.map((element) => element.nodeName).join(","))).toBe("X,Y");
      expect(await page.$$eval(`css=span,div >> css=x`, (elements) => elements.map((element) => element.nodeName).join(","))).toBe("X");
      expect(await page.$$eval(`css=div >> css=x,y`, (elements) => elements.map((element) => element.nodeName).join(","))).toBe("X,Y");
      expect(await page.$$eval(`css=div >> css=x`, (elements) => elements.map((element) => element.nodeName).join(","))).toBe("X");
      expect(await page.$$eval(`css=section >> css=div >> css=x`, (elements) => elements.map((element) => element.nodeName).join(","))).toBe("X");
      expect(await page.$$eval(`css=section >> css=span >> css=div >> css=y`, (elements) => elements.map((element) => element.nodeName).join(","))).toBe("Y");
      expect(await page.$$eval(`css=section >> css=div >> css=x,y`, (elements) => elements.map((element) => element.nodeName).join(","))).toBe("X,Y");
      expect(await page.$$eval(`css=section >> css=div,span >> css=x,y`, (elements) => elements.map((element) => element.nodeName).join(","))).toBe("X,Y");
      expect(await page.$$eval(`css=section >> css=span >> css=x,y`, (elements) => elements.map((element) => element.nodeName).join(","))).toBe("X,Y");
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

  it("does not match the root after selector chain like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent("<section><div>test</div></section>");

      const element = await page.$("css=section >> css=section");
      expect(element).toBe(null);
    });
  });

  it("supports numerical and wrong-case ids like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent('<section id="123"></section>');
      expect(await page.$("#\\31\\32\\33")).toBeTruthy();

      await page.setContent('<section id="Hello"></section>');
      expect(await page.$eval("#Hello", (element) => element.tagName)).toBe("SECTION");
      expect(await page.$eval("#hello", (element) => element.tagName)).toBe("SECTION");
      expect(await page.$eval("#HELLO", (element) => element.tagName)).toBe("SECTION");
      expect(await page.$eval("#helLO", (element) => element.tagName)).toBe("SECTION");
    });
  });

  it("supports star selectors and element-scoped star selectors like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent("<div id=div1></div><div id=div2><span><span></span></span></div>");

      expect(await page.$$eval("*", (elements) => elements.map((element) => `${element.nodeName}${element.id ? `#${element.id}` : ""}`))).toEqual([
        "HTML",
        "HEAD",
        "BODY",
        "DIV#div1",
        "DIV#div2",
        "SPAN",
        "SPAN"
      ]);
      expect(await page.$$eval("*#div1", (elements) => elements.length)).toBe(1);
      expect(await page.$$eval("*:not(#div1)", (elements) => elements.length)).toBe(6);
      expect(await page.$$eval("*:not(div)", (elements) => elements.length)).toBe(5);
      expect(await page.$$eval("*:not(span)", (elements) => elements.length)).toBe(5);
      expect(await page.$$eval("*:not(*)", (elements) => elements.length)).toBe(0);
      expect(await page.$$eval("*:is(*)", (elements) => elements.length)).toBe(7);
      expect(await page.$$eval("* *", (elements) => elements.length)).toBe(6);
      expect(await page.$$eval("* *:not(span)", (elements) => elements.length)).toBe(4);
      expect(await page.$$eval("div > *", (elements) => elements.length)).toBe(1);
      expect(await page.$$eval("div *", (elements) => elements.length)).toBe(2);
      expect(await page.$$eval("* > *", (elements) => elements.length)).toBe(6);

      const body = await page.$("body");
      expect(await body!.$$eval("*", (elements) => elements.length)).toBe(4);
      expect(await body!.$$eval("*#div1", (elements) => elements.length)).toBe(1);
      expect(await body!.$$eval("*:not(#div1)", (elements) => elements.length)).toBe(3);
      expect(await body!.$$eval("*:not(div)", (elements) => elements.length)).toBe(2);
      expect(await body!.$$eval("*:not(span)", (elements) => elements.length)).toBe(2);
      expect(await body!.$$eval("*:not(*)", (elements) => elements.length)).toBe(0);
      expect(await body!.$$eval("*:is(*)", (elements) => elements.length)).toBe(4);
      expect(await body!.$$eval("div > *", (elements) => elements.length)).toBe(1);
      expect(await body!.$$eval("div *", (elements) => elements.length)).toBe(2);
      expect(await body!.$$eval("* > *", (elements) => elements.length)).toBe(2);
      expect(await body!.$$eval(":scope * > *", (elements) => elements.length)).toBe(2);
      expect(await body!.$$eval("* *", (elements) => elements.length)).toBe(2);
      expect(await body!.$$eval("* *:not(span)", (elements) => elements.length)).toBe(0);
    });
  });

  it("supports nth-child of notation with nested functions like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <div>
          <span>span1</span>
          <span class=foo>span2<dd></dd></span>
          <span class=foo>span3<dd class=marker></dd></span>
          <span class=foo>span4<dd class=marker></dd></span>
          <span class=foo>span5<dd></dd></span>
          <span>span6</span>
        </div>
      `);

      expect(await page.$$eval(`css=span:nth-child(1)`, (elements) => elements.map((element) => element.textContent))).toEqual(["span1"]);
      expect(await page.$$eval(`css=span:nth-child(1 of .foo)`, (elements) => elements.map((element) => element.textContent))).toEqual(["span2"]);
      expect(await page.$$eval(`css=span:nth-child(1 of .foo:has(dd.marker))`, (elements) => elements.map((element) => element.textContent))).toEqual(["span3"]);
      expect(await page.$$eval(`css=span:nth-last-child(1 of .foo:has(dd.marker))`, (elements) => elements.map((element) => element.textContent))).toEqual(["span4"]);
      expect(await page.$$eval(`css=span:nth-last-child(1 of .foo)`, (elements) => elements.map((element) => element.textContent))).toEqual(["span5"]);
      expect(await page.$$eval(`css=span:nth-last-child(  1  )`, (elements) => elements.map((element) => element.textContent))).toEqual(["span6"]);
      expect(await page.$$eval(`css=span:nth-child(1 of .foo:nth-child(3))`, (elements) => elements.map((element) => element.textContent))).toEqual(["span3"]);
      expect(await page.$$eval(`css=span:nth-child(1 of .foo:nth-child(6))`, (elements) => elements.map((element) => element.textContent))).toEqual([]);
    });
  });

  it("supports :has selector lists like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent(`<section><span></span><div></div></section><section><br></section>`);

      expect(await page.$$eval(`section:has(span, div)`, (elements) => elements.length)).toBe(1);
      expect(await page.$$eval(`section:has(br)`, (elements) => elements.length)).toBe(1);
      expect(await page.$$eval(`section:has(span, br)`, (elements) => elements.length)).toBe(2);
      expect(await page.$$eval(`section:has(span, br, div)`, (elements) => elements.length)).toBe(2);
    });
  });

  it("supports :scope and class locator filtering like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <div class="apple"></div>
        <div class="apple selected"></div>
      `);

      expect(await page.locator(".apple").locator(":scope.selected").count()).toBe(1);
    });
  });

  it("uses light DOM structure for child combinator with slotted content like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <my-button>
          <template shadowrootmode="open">
            <button><slot></slot></button>
          </template>
          <div class="content">Foo</div>
        </my-button>
      `);

      expect(await page.$eval(`my-button > div`, (element) => element.className)).toBe("content");
      expect(await page.$eval(`my-button > .content`, (element) => element.textContent)).toBe("Foo");
    });
  });

  it("supports sibling combinators and :scope like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <div id=div1></div>
        <div id=div2></div>
        <div id=div3></div>
        <div id=div4></div>
        <div id=div5></div>
        <div id=div6></div>
      `);

      expect(await page.$$eval(`#div3 >> :scope ~ div`, (elements) => elements.map((element) => element.id))).toEqual(["div4", "div5", "div6"]);
      expect(await page.$$eval(`#div3 >> :scope ~ *`, (elements) => elements.map((element) => element.id))).toEqual(["div4", "div5", "div6"]);
      expect(await page.$$eval(`#div3 >> ~ div`, (elements) => elements.map((element) => element.id))).toEqual(["div4", "div5", "div6"]);
      expect(await page.$$eval(`#div3 >> ~ *`, (elements) => elements.map((element) => element.id))).toEqual(["div4", "div5", "div6"]);
      expect(await page.$$eval(`#div3 >> #div1 ~ :scope`, (elements) => elements.map((element) => element.id))).toEqual(["div3"]);
      expect(await page.$$eval(`#div3 >> #div4 ~ :scope`, (elements) => elements.map((element) => element.id))).toEqual([]);
      expect(await page.$$eval(`css=#div1 ~ div ~ #div6`, (elements) => elements.length)).toBe(1);
      expect(await page.$$eval(`css=#div1 ~ div ~ div`, (elements) => elements.length)).toBe(4);
      expect(await page.$$eval(`css=#div3 ~ div ~ div`, (elements) => elements.length)).toBe(2);
      expect(await page.$$eval(`css=#div4 ~ div ~ div`, (elements) => elements.length)).toBe(1);
      expect(await page.$$eval(`css=#div5 ~ div ~ div`, (elements) => elements.length)).toBe(0);
      expect(await page.$$eval(`css=#div3 ~ #div2 ~ #div6`, (elements) => elements.length)).toBe(0);
      expect(await page.$$eval(`css=#div3 ~ #div4 ~ #div5`, (elements) => elements.length)).toBe(1);
    });
  });

  it("supports adjacent sibling combinators and relative selectors like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <section>
          <div id=div1></div>
          <div id=div2></div>
          <div id=div3></div>
          <div id=div4></div>
          <div id=div5></div>
          <div id=div6></div>
        </section>
      `);

      expect(await page.$$eval(`#div1 >> :scope+div`, (elements) => elements.map((element) => element.id))).toEqual(["div2"]);
      expect(await page.$$eval(`#div1 >> :scope+*`, (elements) => elements.map((element) => element.id))).toEqual(["div2"]);
      expect(await page.$$eval(`#div1 >> + div`, (elements) => elements.map((element) => element.id))).toEqual(["div2"]);
      expect(await page.$$eval(`#div1 >> + *`, (elements) => elements.map((element) => element.id))).toEqual(["div2"]);
      expect(await page.$$eval(`#div3 >> div + :scope`, (elements) => elements.map((element) => element.id))).toEqual(["div3"]);
      expect(await page.$$eval(`#div3 >> #div1 + :scope`, (elements) => elements.map((element) => element.id))).toEqual([]);
      expect(await page.$$eval(`css=#div1 ~ div + #div6`, (elements) => elements.length)).toBe(1);
      expect(await page.$$eval(`css=#div1 ~ div + div`, (elements) => elements.length)).toBe(4);
      expect(await page.$$eval(`css=#div3 + div + div`, (elements) => elements.length)).toBe(1);
      expect(await page.$$eval(`css=#div4 ~ #div5 + div`, (elements) => elements.length)).toBe(1);
      expect(await page.$$eval(`css=#div5 + div + div`, (elements) => elements.length)).toBe(0);
      expect(await page.$$eval(`css=#div3 ~ #div2 + #div6`, (elements) => elements.length)).toBe(0);
      expect(await page.$$eval(`css=#div3 + #div4 + #div5`, (elements) => elements.length)).toBe(1);
      expect(await page.$$eval(`css=div + #div1`, (elements) => elements.length)).toBe(0);
      expect(await page.$$eval(`css=section > div + div ~ div`, (elements) => elements.length)).toBe(4);
      expect(await page.$$eval(`css=section > div + #div4 ~ div`, (elements) => elements.length)).toBe(2);
      expect(await page.$$eval(`css=section:has(:scope > div + #div2)`, (elements) => elements.length)).toBe(1);
      expect(await page.$$eval(`css=section:has(:scope > div + #div1)`, (elements) => elements.length)).toBe(0);
      expect(await page.$eval(`css=div:has(:scope + #div5)`, (element) => element.id)).toBe("div4");
    });
  });

  it("supports :scope and handle-relative CSS selectors like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent(`<article><div class=target>hello<span></span></div></article>`);

      expect(await page.$eval(`div >> :scope.target`, (element) => element.textContent)).toBe("hello");
      expect(await page.$eval(`div >> :scope:nth-child(1)`, (element) => element.textContent)).toBe("hello");
      expect(await page.$eval(`div >> :scope.target:has(span)`, (element) => element.textContent)).toBe("hello");
      expect(await page.$eval(`html:scope`, (element) => element.nodeName)).toBe("HTML");

      await page.setContent(`
        <span class="find-me" id=target1>1</span>
        <div>
          <span class="find-me" id=target2>2</span>
        </div>
      `);
      expect(await page.$eval(`.find-me`, (element) => element.id)).toBe("target1");

      const div = await page.$("div");
      expect(await div!.$eval(`.find-me`, (element) => element.id)).toBe("target2");
      expect(await page.$eval(`div >> .find-me`, (element) => element.id)).toBe("target2");
    });
  });

  it("absolutizes relative selectors like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent(`<div><span>Hi</span></div>`);

      expect(await page.$eval("div >> >span", (element) => element.textContent)).toBe("Hi");
      expect(await page.locator("div").locator(">span").textContent()).toBe("Hi");
      expect(await page.$eval("div:has(> span)", (element) => element.outerHTML)).toBe("<div><span>Hi</span></div>");
      expect(await page.$("div:has(> div)")).toBe(null);
    });
  });
});
