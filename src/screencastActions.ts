export const RENDER_SCREENCAST_ACTIONS_SOURCE = String.raw`(payload) => {
  const styleId = "__roxy_screencast_actions_style__";
  const containerTag = "x-pw-action-overlays";
  const highlightTag = "x-pw-highlight";
  const pointTag = "x-pw-action-point";
  const titleTag = "x-pw-title";
  const cursorTag = "x-pw-action-cursor";

  const ensureStyle = () => {
    if (document.getElementById(styleId))
      return;
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = [
      containerTag + " {",
      "  position: fixed;",
      "  inset: 0;",
      "  pointer-events: none;",
      "  z-index: 2147483647;",
      "}",
      highlightTag + ", " + pointTag + ", " + titleTag + ", " + cursorTag + " {",
      "  position: fixed;",
      "  pointer-events: none;",
      "  box-sizing: border-box;",
      "}",
      highlightTag + " {",
      "  background: rgba(0, 128, 255, 0.15);",
      "  border: 2px solid rgba(0, 128, 255, 0.6);",
      "  border-radius: 8px;",
      "}",
      pointTag + " {",
      "  width: 20px;",
      "  height: 20px;",
      "  margin-left: -10px;",
      "  margin-top: -10px;",
      "  background: rgb(255, 0, 0);",
      "  border-radius: 10px;",
      "}",
      titleTag + " {",
      "  color: rgb(255, 255, 255);",
      "  background: rgba(0, 0, 0, 0.8);",
      "  border-radius: 6px;",
      "  padding: 6px;",
      "  font: 14px/1.4 sans-serif;",
      "}",
      cursorTag + " {",
      "  width: 18px;",
      "  height: 22px;",
      "  margin-left: 2px;",
      "  margin-top: 2px;",
      "  transition: top 160ms ease, left 160ms ease;",
      "}",
      cursorTag + " svg {",
      "  display: block;",
      "  width: 18px;",
      "  height: 22px;",
      "}"
    ].join("\n");
    document.head.appendChild(style);
  };

  const ensureContainer = () => {
    let container = document.querySelector(containerTag);
    if (container instanceof HTMLElement)
      return container;
    container = document.createElement(containerTag);
    container.setAttribute("aria-hidden", "true");
    const highlight = document.createElement(highlightTag);
    highlight.hidden = true;
    container.appendChild(highlight);
    const point = document.createElement(pointTag);
    point.hidden = true;
    container.appendChild(point);
    const title = document.createElement(titleTag);
    title.hidden = true;
    container.appendChild(title);
    const cursor = document.createElement(cursorTag);
    cursor.hidden = true;
    cursor.innerHTML = [
      '<svg viewBox="0 0 18 22" xmlns="http://www.w3.org/2000/svg">',
      '<path d="M1 1 L1 17 L5.5 13 L8 20.5 L11 19.5 L8.5 12 L15 12 Z" fill="white" stroke="black" stroke-width="1.5" stroke-linejoin="round"></path>',
      "</svg>"
    ].join("");
    container.appendChild(cursor);
    document.documentElement.appendChild(container);
    return container;
  };

  const applyTitlePosition = (element, position) => {
    element.style.top = "";
    element.style.bottom = "";
    element.style.left = "";
    element.style.right = "";
    element.style.transform = "";
    switch (position) {
      case "top-left":
        element.style.top = "6px";
        element.style.left = "6px";
        return;
      case "top":
        element.style.top = "6px";
        element.style.left = "50%";
        element.style.transform = "translateX(-50%)";
        return;
      case "bottom-left":
        element.style.bottom = "6px";
        element.style.left = "6px";
        return;
      case "bottom":
        element.style.bottom = "6px";
        element.style.left = "50%";
        element.style.transform = "translateX(-50%)";
        return;
      case "bottom-right":
        element.style.bottom = "6px";
        element.style.right = "6px";
        return;
      case "top-right":
      default:
        element.style.top = "6px";
        element.style.right = "6px";
    }
  };

  ensureStyle();
  const container = ensureContainer();
  const highlight = container.querySelector(highlightTag);
  const point = container.querySelector(pointTag);
  const title = container.querySelector(titleTag);
  const cursor = container.querySelector(cursorTag);

  if (!(highlight instanceof HTMLElement) || !(point instanceof HTMLElement) || !(title instanceof HTMLElement) || !(cursor instanceof HTMLElement))
    return;

  const hasAnnotation = !!payload.enabled && !!payload.annotation;
  container.hidden = !hasAnnotation;

  if (!hasAnnotation) {
    highlight.hidden = true;
    point.hidden = true;
    title.hidden = true;
    cursor.hidden = true;
    return;
  }

  const annotation = payload.annotation;

  if (annotation.highlightBox) {
    highlight.hidden = false;
    highlight.style.left = annotation.highlightBox.left + "px";
    highlight.style.top = annotation.highlightBox.top + "px";
    highlight.style.width = annotation.highlightBox.width + "px";
    highlight.style.height = annotation.highlightBox.height + "px";
  } else {
    highlight.hidden = true;
  }

  if (annotation.point) {
    point.hidden = false;
    point.style.left = annotation.point.x + "px";
    point.style.top = annotation.point.y + "px";
  } else {
    point.hidden = true;
  }

  if (annotation.title) {
    title.hidden = false;
    title.textContent = annotation.title;
    title.style.fontSize = annotation.fontSize ? annotation.fontSize + "px" : "";
    applyTitlePosition(title, annotation.position);
  } else {
    title.hidden = true;
  }

  if (annotation.cursorPoint && annotation.cursor !== "none") {
    cursor.hidden = false;
    cursor.style.left = annotation.cursorPoint.x + "px";
    cursor.style.top = annotation.cursorPoint.y + "px";
  } else {
    cursor.hidden = true;
  }
}`;
