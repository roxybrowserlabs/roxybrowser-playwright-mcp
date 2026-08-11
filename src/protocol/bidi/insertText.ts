export const BIDI_INSERT_TEXT_SOURCE = `(payload) => {
  const bidiInsertText = (targetWindow, text) => {
    let element = targetWindow.document.activeElement;
    while (element?.shadowRoot)
      element = element.shadowRoot.activeElement;
    if (!element)
      return;
    const elementType = element.nodeName.toLocaleLowerCase();
    if (elementType === "iframe" || elementType === "frame") {
      return element;
    } else if (elementType === "input" || elementType === "textarea") {
      const inputElement = element;
      const start = inputElement.selectionStart;
      if (start === null) {
        inputElement.value += text;
      } else {
        let value = inputElement.value;
        value = value.substring(0, start) + text + value.substring(inputElement.selectionEnd);
        inputElement.value = value;
        const caretPosition = start + text.length;
        inputElement.setSelectionRange(caretPosition, caretPosition);
      }
      inputElement.dispatchEvent(new targetWindow.InputEvent("input", {
        data: text,
        bubbles: true,
        composed: true
      }));
    } else if (element instanceof targetWindow.HTMLElement && element.isContentEditable) {
      const selection = targetWindow.getSelection();
      let range;
      if (selection?.rangeCount)
        range = selection.getRangeAt(0);
      if (!range || !element.contains(range.commonAncestorContainer)) {
        range = targetWindow.document.createRange();
        range.selectNodeContents(element);
        range.collapse(true);
      }
      range.deleteContents();
      const lines = text.split("\\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        range.insertNode(targetWindow.document.createTextNode(lines[i]));
        if (i > 0)
          range.insertNode(targetWindow.document.createElement("br"));
      }
      range.collapse();
      selection?.removeAllRanges();
      selection?.addRange(range);
      element.dispatchEvent(new targetWindow.InputEvent("input", {
        data: text,
        bubbles: true,
        composed: true
      }));
    }
  };
  return bidiInsertText(window, payload.text);
}`;
