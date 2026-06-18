export const RENDER_SCREencast_OVERLAYS_SOURCE = String.raw`(payload) => {
  const styleId = "__roxy_screencast_overlay_style__";
  const containerTag = "x-pw-user-overlays";
  const overlayClassName = "x-pw-user-overlay";

  const ensureStyle = () => {
    if (document.getElementById(styleId))
      return;
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = [
      containerTag + ", ." + overlayClassName + " {",
      "  position: fixed;",
      "  inset: 0;",
      "}",
      containerTag + " {",
      "  pointer-events: none;",
      "  z-index: 2147483647;",
      "}",
      "." + overlayClassName + " {",
      "  pointer-events: none;",
      "}",
      "." + overlayClassName + "[data-roxy-kind=\"chapter\"] {",
      "  display: flex;",
      "  align-items: center;",
      "  justify-content: center;",
      "  background: rgba(0, 0, 0, 0.24);",
      "  backdrop-filter: blur(8px);",
      "}",
      "." + overlayClassName + "[data-roxy-kind=\"chapter\"] > div {",
      "  background: rgba(0, 0, 0, 0.62);",
      "  color: white;",
      "  padding: 24px 28px;",
      "  border-radius: 16px;",
      "  max-width: min(720px, calc(100vw - 48px));",
      "  text-align: center;",
      "  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.28);",
      "}",
      "." + overlayClassName + "[data-roxy-kind=\"chapter\"] h1 {",
      "  margin: 0;",
      "  font-size: 32px;",
      "  line-height: 1.2;",
      "}",
      "." + overlayClassName + "[data-roxy-kind=\"chapter\"] p {",
      "  margin: 12px 0 0;",
      "  font-size: 18px;",
      "  line-height: 1.4;",
      "  opacity: 0.92;",
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
    document.documentElement.appendChild(container);
    return container;
  };

  const sanitizeOverlay = (element) => {
    for (const script of element.querySelectorAll("script"))
      script.remove();
    for (const child of element.querySelectorAll("*")) {
      for (const attribute of [...child.attributes]) {
        if (attribute.name.toLowerCase().startsWith("on"))
          child.removeAttribute(attribute.name);
      }
    }
  };

  ensureStyle();
  const container = ensureContainer();
  const desiredIds = new Set(payload.overlays.map((entry) => entry.id));
  const existingSelector = "." + overlayClassName + "[data-roxy-overlay-id]";

  for (const existing of [...container.querySelectorAll(existingSelector)]) {
    const id = existing.getAttribute("data-roxy-overlay-id");
    if (!id || !desiredIds.has(id))
      existing.remove();
  }

  for (const entry of payload.overlays) {
    const overlaySelector = "." + overlayClassName + "[data-roxy-overlay-id=\"" + entry.id + "\"]";
    let element = container.querySelector(overlaySelector);
    if (!(element instanceof HTMLElement)) {
      element = document.createElement("div");
      element.className = overlayClassName;
      element.setAttribute("data-roxy-overlay-id", entry.id);
      container.appendChild(element);
    }
    if (entry.kind)
      element.setAttribute("data-roxy-kind", entry.kind);
    else
      element.removeAttribute("data-roxy-kind");

    element.innerHTML = entry.html;
    sanitizeOverlay(element);
  }

  container.hidden = !payload.visible || payload.overlays.length === 0;
}`;

export function createChapterOverlayHtml(title: string, description?: string): string {
  const escapedTitle = escapeHtml(title);
  const descriptionHtml = description ? `<p>${escapeHtml(description)}</p>` : "";
  return `<div><h1>${escapedTitle}</h1>${descriptionHtml}</div>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
