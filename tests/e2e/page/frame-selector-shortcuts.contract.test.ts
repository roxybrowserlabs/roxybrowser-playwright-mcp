import { describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";

describe("frame selector shortcut contract e2e", () => {
  it("matches Playwright frame selector read and state shortcuts", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <label><input id="checked" type="checkbox" checked>Checked</label>
        <input id="disabled" disabled value="disabled value">
        <input id="editable" value="editable value">
        <div id="hidden" style="display:none">hidden text</div>
        <section id="section" data-kind="example"><span>Inner text</span></section>
      `);

      const frame = page.mainFrame();

      expect(await frame.textContent("#section")).toBe("Inner text");
      expect(await frame.innerText("#section")).toBe("Inner text");
      expect(await frame.innerHTML("#section")).toBe("<span>Inner text</span>");
      expect(await frame.getAttribute("#section", "data-kind")).toBe("example");
      expect(await frame.inputValue("#editable")).toBe("editable value");
      expect(await frame.isChecked("#checked")).toBe(true);
      expect(await frame.isDisabled("#disabled")).toBe(true);
      expect(await frame.isEditable("#editable")).toBe(true);
      expect(await frame.isEnabled("#editable")).toBe(true);
      expect(await frame.isHidden("#hidden")).toBe(true);
      expect(await frame.isVisible("#section")).toBe(true);

      expect(await page.textContent("#section")).toBe("Inner text");
      expect(await page.isVisible("#missing")).toBe(false);
      expect(await page.isHidden("#missing")).toBe(true);
    });
  });

  it("matches Playwright frame selector action shortcuts", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <button id="button" onclick="window.clicked = true">Click</button>
        <input id="input" onfocus="window.focused = true" oninput="window.inputValue = this.value">
        <input id="checkbox" type="checkbox">
        <select id="select" onchange="window.selected = this.value">
          <option value="red">Red</option>
          <option value="blue">Blue</option>
        </select>
      `);

      const frame = page.mainFrame();

      await frame.focus("#input");
      expect(await page.evaluate(() => (window as any).focused)).toBe(true);

      await frame.fill("#input", "typed");
      expect(await page.evaluate(() => (window as any).inputValue)).toBe("typed");

      await frame.check("#checkbox");
      expect(await frame.isChecked("#checkbox")).toBe(true);
      await frame.setChecked("#checkbox", false);
      expect(await frame.isChecked("#checkbox")).toBe(false);

      expect(await frame.selectOption("#select", "blue")).toEqual(["blue"]);
      expect(await page.evaluate(() => (window as any).selected)).toBe("blue");

      await frame.tap("#button");
      expect(await page.evaluate(() => (window as any).clicked)).toBe(true);
    });
  });
});
