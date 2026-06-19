import { describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";

describe("page text selector contract e2e", () => {
  it("supports basic text selectors like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent(`<div>yo</div><div>ya</div><div>\nye  </div>`);

      expect(await page.$eval(`text=ya`, (element) => element.outerHTML)).toBe("<div>ya</div>");
      expect(await page.$eval(`text="ya"`, (element) => element.outerHTML)).toBe("<div>ya</div>");
      expect(await page.$eval(`text=/^[ay]+$/`, (element) => element.outerHTML)).toBe("<div>ya</div>");
      expect(await page.$eval(`text=/Ya/i`, (element) => element.outerHTML)).toBe("<div>ya</div>");
      expect(await page.$eval(`text=ye`, (element) => element.outerHTML)).toBe("<div>\nye  </div>");
      expect(await page.getByText("ye").evaluate((element) => element.outerHTML)).toContain(">\nye  </div>");

      await page.setContent(`<div> ye </div><div>ye</div>`);
      expect(await page.$eval(`text="ye"`, (element) => element.outerHTML)).toBe("<div> ye </div>");
      expect(await page.getByText("ye", { exact: true }).first().evaluate((element) => element.outerHTML)).toContain("> ye </div>");

      await page.setContent(`<div>yo</div><div>"ya</div><div> hello world! </div>`);
      expect(await page.$eval(`text="\\"ya"`, (element) => element.outerHTML)).toBe('<div>"ya</div>');
      expect(await page.$eval(`text=/hello/`, (element) => element.outerHTML)).toBe("<div> hello world! </div>");
      expect(await page.$eval(`text=/^\\s*heLLo/i`, (element) => element.outerHTML)).toBe("<div> hello world! </div>");
    });
  });

  it("supports chained and quoted text selectors like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent(`<div>yo<div>ya</div>hey<div>hey</div></div>`);

      expect(await page.$eval(`text=hey`, (element) => element.outerHTML)).toBe("<div>hey</div>");
      expect(await page.$eval(`text=yo>>text="ya"`, (element) => element.outerHTML)).toBe("<div>ya</div>");
      expect(await page.$eval(`text=yo>> text="ya"`, (element) => element.outerHTML)).toBe("<div>ya</div>");
      expect(await page.$eval(`text=yo >>text='ya'`, (element) => element.outerHTML)).toBe("<div>ya</div>");
      expect(await page.$eval(`text=yo >> text='ya'`, (element) => element.outerHTML)).toBe("<div>ya</div>");
      expect(await page.$eval(`'yo'>>"ya"`, (element) => element.outerHTML)).toBe("<div>ya</div>");
      expect(await page.$eval(`"yo" >> 'ya'`, (element) => element.outerHTML)).toBe("<div>ya</div>");

      await page.setContent(`<div>yo<span id="s1"></span></div><div>yo<span id="s2"></span><span id="s3"></span></div>`);
      expect(await page.$$eval(`text=yo`, (elements) => elements.map((element) => element.outerHTML).join("\n"))).toBe(
        '<div>yo<span id="s1"></span></div>\n<div>yo<span id="s2"></span><span id="s3"></span></div>'
      );
    });
  });

  it("supports text selector escapes and separators like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent(`<div>'</div><div>"</div><div>\\</div><div>x</div>`);

      expect(await page.$eval(`text='\\''`, (element) => element.outerHTML)).toBe("<div>'</div>");
      expect(await page.$eval(`text='"'`, (element) => element.outerHTML)).toBe('<div>"</div>');
      expect(await page.$eval(`text="\\""`, (element) => element.outerHTML)).toBe('<div>"</div>');
      expect(await page.$eval(`text="'"`, (element) => element.outerHTML)).toBe("<div>'</div>");
      expect(await page.$eval(`text="\\x"`, (element) => element.outerHTML)).toBe("<div>x</div>");
      expect(await page.$eval(`text='\\x'`, (element) => element.outerHTML)).toBe("<div>x</div>");
      expect(await page.$eval(`text='\\\\'`, (element) => element.outerHTML)).toBe("<div>\\</div>");
      expect(await page.$eval(`text="\\\\"`, (element) => element.outerHTML)).toBe("<div>\\</div>");
      expect(await page.$eval(`text="`, (element) => element.outerHTML)).toBe('<div>"</div>');
      expect(await page.$eval(`text='`, (element) => element.outerHTML)).toBe("<div>'</div>");
      expect(await page.$eval(`"x"`, (element) => element.outerHTML)).toBe("<div>x</div>");
      expect(await page.$eval(`'x'`, (element) => element.outerHTML)).toBe("<div>x</div>");

      await expect(page.$(`"`)).rejects.toBeInstanceOf(Error);
      await expect(page.$(`'`)).rejects.toBeInstanceOf(Error);

      await page.setContent(`<div>Hi''&gt;&gt;foo=bar</div>`);
      expect(await page.$eval(`text="Hi''>>foo=bar"`, (element) => element.outerHTML)).toBe("<div>Hi''&gt;&gt;foo=bar</div>");

      await page.setContent(`<div>Hi&gt;&gt;<span></span></div>`);
      expect(await page.$eval(`text="Hi>>">>span`, (element) => element.outerHTML)).toBe("<span></span>");
      expect(await page.$eval(`text=/Hi\\>\\>/ >> span`, (element) => element.outerHTML)).toBe("<span></span>");
    });
  });

  it("normalizes whitespace and adjacent text nodes like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent(`<div>a<br>b</div><div>a</div>`);
      expect(await page.$eval(`text=a`, (element) => element.outerHTML)).toBe("<div>a<br>b</div>");
      expect(await page.$eval(`text=b`, (element) => element.outerHTML)).toBe("<div>a<br>b</div>");
      expect(await page.$eval(`text=ab`, (element) => element.outerHTML)).toBe("<div>a<br>b</div>");
      expect(await page.$(`text=abc`)).toBe(null);
      expect(await page.$$eval(`text=a`, (elements) => elements.length)).toBe(2);
      expect(await page.$$eval(`text=b`, (elements) => elements.length)).toBe(1);
      expect(await page.$$eval(`text=ab`, (elements) => elements.length)).toBe(1);
      expect(await page.$$eval(`text=abc`, (elements) => elements.length)).toBe(0);

      await page.setContent(`<div></div><span></span>`);
      await page.$eval("div", (div) => {
        div.appendChild(document.createTextNode("hello"));
        div.appendChild(document.createTextNode("world"));
      });
      await page.$eval("span", (span) => {
        span.appendChild(document.createTextNode("hello"));
        span.appendChild(document.createTextNode("world"));
      });
      expect(await page.$eval(`text=lowo`, (element) => element.outerHTML)).toBe("<div>helloworld</div>");
      expect(await page.$$eval(`text=lowo`, (elements) => elements.map((element) => element.outerHTML).join(""))).toBe("<div>helloworld</div><span>helloworld</span>");

      await page.setContent(`<span>Sign&nbsp;in</span><span>Hello\n \nworld</span>`);
      expect(await page.$eval(`text=Sign in`, (element) => element.outerHTML)).toBe("<span>Sign&nbsp;in</span>");
      expect(await page.$$(`text=Sign \tin`)).toHaveLength(1);
      expect(await page.$$(`text="Sign in"`)).toHaveLength(1);
      expect(await page.$eval(`text=lo wo`, (element) => element.outerHTML)).toBe("<span>Hello\n \nworld</span>");
      expect(await page.$eval(`text="Hello world"`, (element) => element.outerHTML)).toBe("<span>Hello\n \nworld</span>");
      expect(await page.$(`text="lo wo"`)).toBe(null);
      expect(await page.$$(`text=lo \nwo`)).toHaveLength(1);
      expect(await page.$$(`text="lo \nwo"`)).toHaveLength(0);
    });
  });

  it("supports CSS text pseudo selectors like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent(`<div>yo</div><div>ya</div><div>\nHELLO   \n world  </div>`);

      expect(await page.$eval(`:text("ya")`, (element) => element.outerHTML)).toBe("<div>ya</div>");
      expect(await page.$eval(`:text-is("ya")`, (element) => element.outerHTML)).toBe("<div>ya</div>");
      expect(await page.$eval(`:text("y")`, (element) => element.outerHTML)).toBe("<div>yo</div>");
      expect(await page.$(`:text-is("Y")`)).toBe(null);
      expect(await page.$eval(`:text("hello world")`, (element) => element.outerHTML)).toBe("<div>\nHELLO   \n world  </div>");
      expect(await page.$eval(`:text-is("HELLO world")`, (element) => element.outerHTML)).toBe("<div>\nHELLO   \n world  </div>");
      expect(await page.$eval(`:text("lo wo")`, (element) => element.outerHTML)).toBe("<div>\nHELLO   \n world  </div>");
      expect(await page.$(`:text-is("lo wo")`)).toBe(null);
      expect(await page.$eval(`:text-matches("^[ay]+$")`, (element) => element.outerHTML)).toBe("<div>ya</div>");
      expect(await page.$eval(`:text-matches("y", "g")`, (element) => element.outerHTML)).toBe("<div>yo</div>");
      expect(await page.$eval(`:text-matches("Y", "i")`, (element) => element.outerHTML)).toBe("<div>yo</div>");
      expect(await page.$(`:text-matches("^y$")`)).toBe(null);

      const error1 = await page.$(`:text("foo", "bar")`).catch((error) => error);
      expect(error1.message).toContain(`"text" engine expects a single string`);
      const error2 = await page.$(`:text(foo > bar)`).catch((error) => error);
      expect(error2.message).toContain(`"text" engine expects a single string`);
    });
  });

  it("supports empty string CSS text pseudo selectors like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent(`<div></div><div>ya</div><div>\nHELLO   \n world  </div>`);

      expect(await page.$eval(`div:text-is("")`, (element) => element.outerHTML)).toBe("<div></div>");
      expect(await page.$$eval(`div:text-is("")`, (elements) => elements.length)).toBe(1);
      expect(await page.$eval(`div:text("")`, (element) => element.outerHTML)).toBe("<div></div>");
      expect(await page.$$eval(`div:text("")`, (elements) => elements.length)).toBe(3);
      expect(await page.$eval(`div >> text=""`, (element) => element.outerHTML)).toBe("<div></div>");
      expect(await page.$$eval(`div >> text=""`, (elements) => elements.length)).toBe(1);
      expect(await page.$eval(`div >> text=/^$/`, (element) => element.outerHTML)).toBe("<div></div>");
      expect(await page.$$eval(`div >> text=/^$/`, (elements) => elements.length)).toBe(1);
      expect(await page.$eval(`div:text-matches("")`, (element) => element.outerHTML)).toBe("<div></div>");
      expect(await page.$$eval(`div:text-matches("")`, (elements) => elements.length)).toBe(3);
    });
  });

  it("supports CSS has-text pseudo selectors like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <input id=input2>
        <div id=div1>
          <span>  Find me  </span>
          or
          <wrap><span id=span2>maybe me  </span></wrap>
          <div><input id=input1></div>
        </div>
      `);

      expect(await page.$eval(`:has-text("find me")`, (element) => element.tagName)).toBe("HTML");
      expect(await page.$eval(`span:has-text("find me")`, (element) => element.outerHTML)).toBe("<span>  Find me  </span>");
      expect(await page.$eval(`div:has-text("find me")`, (element) => element.id)).toBe("div1");
      expect(await page.$eval(`div:has-text("find me") input`, (element) => element.id)).toBe("input1");
      expect(await page.$eval(`:has-text("find me") input`, (element) => element.id)).toBe("input2");
      expect(await page.$eval(`div:has-text("find me or maybe me")`, (element) => element.id)).toBe("div1");
      expect(await page.$(`div:has-text("find noone")`)).toBe(null);
      expect(await page.$$eval(`:is(div,span):has-text("maybe")`, (elements) => elements.map((element) => element.id).join(";"))).toBe("div1;span2");
      expect(await page.$eval(`div:has-text("find me") :has-text("maybe me")`, (element) => element.tagName)).toBe("WRAP");
      expect(await page.$eval(`div:has-text("find me") span:has-text("maybe me")`, (element) => element.id)).toBe("span2");

      await page.setContent(`<div id=me>hello
      wo"r>>ld</div>`);
      expect(await page.$eval(`div:has-text("hello wo\\"r>>ld")`, (element) => element.id)).toBe("me");
      expect(await page.$eval(`div:has-text("hello\\a wo\\"r>>ld")`, (element) => element.id)).toBe("me");

      const error1 = await page.$(`:has-text("foo", "bar")`).catch((error) => error);
      expect(error1.message).toContain(`"has-text" engine expects a single string`);
      const error2 = await page.$(`:has-text(foo > bar)`).catch((error) => error);
      expect(error2.message).toContain(`"has-text" engine expects a single string`);
    });
  });

  it("matches text selector root after chained selector like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent("<section>test</section>");

      const element = await page.$("css=section >> text=test");
      expect(element).toBeTruthy();
      const element2 = await page.$("text=test >> text=test");
      expect(element2).toBeTruthy();
    });
  });

  it("matches text selector root after chained selector with capture like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent(`<button> hello world </button> <button> hellow <span> world </span> </button>`);

      expect(await page.$$eval("*css=button >> text=hello >> text=world", (elements) => elements.length)).toBe(2);
    });
  });

  it("prioritizes light DOM over shadow DOM text in the same parent like Playwright", async () => {
    await withPage(async (page) => {
      await page.evaluate(() => {
        const div = document.createElement("div");
        document.body.appendChild(div);

        div.attachShadow({ mode: "open" });
        const shadowSpan = document.createElement("span");
        shadowSpan.textContent = "Hello from shadow";
        div.shadowRoot!.appendChild(shadowSpan);

        const lightSpan = document.createElement("span");
        lightSpan.textContent = "Hello from light";
        div.appendChild(lightSpan);
      });

      expect(await page.$eval("div >> text=Hello", (element) => element.textContent)).toBe("Hello from light");
    });
  });

  it("keeps quoted text selectors case sensitive like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent(`<div>yo</div><div>ya</div><div>\nye  </div>`);

      expect(await page.$eval("text=yA", (element) => element.outerHTML)).toBe("<div>ya</div>");
      expect(await page.$(`text="yA"`)).toBe(null);
      expect(await page.$(`text= "ya"`)).toBe(null);
    });
  });

  it("searches for substrings only without quotes like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent("<div>textwithsubstring</div>");

      expect(await page.$eval("text=with", (element) => element.outerHTML)).toBe("<div>textwithsubstring</div>");
      expect(await page.$(`text="with"`)).toBe(null);
    });
  });

  it("matches text selectors with leading and trailing spaces like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent("<button> Add widget </button>");

      expect(await page.$("text=Add widget")).toBeTruthy();
      expect(await page.$("text= Add widget ")).toBeTruthy();
    });
  });

  it("supports unpaired quotes when not at the start like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <div>hello"world<span>yay</span></div>
        <div>hello'world<span>nay</span></div>
        <div>hello\`world<span>oh</span></div>
        <div>hello\`world<span>oh2</span></div>
      `);

      expect(await page.$eval(`text=lo" >> span`, (element) => element.outerHTML)).toBe("<span>yay</span>");
      expect(await page.$eval(`  text=lo" >> span`, (element) => element.outerHTML)).toBe("<span>yay</span>");
      expect(await page.$eval(`text  =lo" >> span`, (element) => element.outerHTML)).toBe("<span>yay</span>");
      expect(await page.$eval(`text=  lo" >> span`, (element) => element.outerHTML)).toBe("<span>yay</span>");
      expect(await page.$eval(` text = lo" >> span`, (element) => element.outerHTML)).toBe("<span>yay</span>");
      expect(await page.$eval(`text=o"wor >> span`, (element) => element.outerHTML)).toBe("<span>yay</span>");

      expect(await page.$eval(`text=lo'wor >> span`, (element) => element.outerHTML)).toBe("<span>nay</span>");
      expect(await page.$eval(`text=o' >> span`, (element) => element.outerHTML)).toBe("<span>nay</span>");

      expect(await page.$eval("text=ello`wor >> span", (element) => element.outerHTML)).toBe("<span>oh</span>");
      expect(await page.locator("text=ello`wor").locator("span").first().textContent()).toBe("oh");
      expect(await page.locator("text=ello`wor").locator("span").nth(1).textContent()).toBe("oh2");
    });
  });
});
