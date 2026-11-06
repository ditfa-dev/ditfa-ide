/**
 * Just enough of the DOM for the round-table card: parsing `innerHTML`, attributes, `closest`, `querySelector`
 * with simple selectors, and node identity. The workspace has no jsdom or happy-dom, and the card only needs this.
 */

const VOID = new Set(["area", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "wbr"]);

export class FakeText {
  parent: FakeElement | null = null;
  constructor(public text: string) {}
}

type Child = FakeElement | FakeText;

export class FakeElement {
  parent: FakeElement | null = null;
  childNodes: Child[] = [];
  readonly attributes = new Map<string, string>();
  ownerDocument: { activeElement: FakeElement | null } | null;

  constructor(
    readonly tagName: string,
    readonly doc: FakeDocument,
  ) {
    this.ownerDocument = doc;
  }

  get children(): FakeElement[] {
    return this.childNodes.filter((node): node is FakeElement => node instanceof FakeElement);
  }

  get firstElementChild(): FakeElement | null {
    return this.children[0] ?? null;
  }

  get isConnected(): boolean {
    let node: FakeElement | null = this;
    while (node) {
      if (node === this.doc.body) return true;
      node = node.parent;
    }
    return false;
  }

  get textContent(): string {
    return this.childNodes.map((node) => (node instanceof FakeText ? node.text : node.textContent)).join("");
  }

  get disabled(): boolean {
    return this.attributes.has("disabled");
  }

  set innerHTML(html: string) {
    for (const node of this.childNodes) node.parent = null;
    this.childNodes = [];
    parseInto(this, html);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  append(child: FakeElement): void {
    child.parent = this;
    this.childNodes.push(child);
  }

  contains(other: FakeElement | null): boolean {
    for (let node = other; node; node = node.parent) {
      if (node === this) return true;
    }
    return false;
  }

  matches(selector: string): boolean {
    return selector.split(",").some((part) => matchesChain(this, part.trim().split(/\s+/)));
  }

  closest(selector: string): FakeElement | null {
    for (let node: FakeElement | null = this; node; node = node.parent) {
      if (node.matches(selector)) return node;
    }
    return null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const found: FakeElement[] = [];
    const walk = (node: FakeElement) => {
      for (const child of node.children) {
        if (child.matches(selector)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  focus(): void {
    this.doc.activeElement = this;
  }
}

export class FakeDocument {
  activeElement: FakeElement | null = null;
  readonly body = new FakeElement("body", this);

  createElement(tag: string): FakeElement {
    return new FakeElement(tag, this);
  }
}

/** `[data-k="x"]`, `[hidden]`, `.class`, `tag`, `:not([hidden])` compounds, joined by descendant spaces. */
function matchesChain(element: FakeElement, parts: string[]): boolean {
  const last = parts[parts.length - 1];
  if (last === undefined || !matchesCompound(element, last)) return false;
  if (parts.length === 1) return true;
  for (let node = element.parent; node; node = node.parent) {
    if (matchesChain(node, parts.slice(0, -1))) return true;
  }
  return false;
}

function matchesCompound(element: FakeElement, compound: string): boolean {
  const pattern = /:not\(([^)]*)\)|\[([\w-]+)(?:="((?:[^"\\]|\\.)*)")?\]|\.([\w-]+)|^([\w-]+)/g;
  let consumed = 0;
  for (const match of compound.matchAll(pattern)) {
    consumed += match[0].length;
    const [, not, attr, value, className, tag] = match;
    if (not !== undefined) {
      if (matchesCompound(element, not)) return false;
    } else if (attr !== undefined) {
      const actual = element.getAttribute(attr);
      if (actual === null || (value !== undefined && actual !== value.replace(/\\(.)/g, "$1"))) return false;
    } else if (className !== undefined) {
      if (!(element.getAttribute("class") ?? "").split(/\s+/).includes(className)) return false;
    } else if (tag !== undefined && element.tagName !== tag) {
      return false;
    }
  }
  if (consumed !== compound.length) throw new Error(`Unsupported selector: ${compound}`);
  return true;
}

function parseInto(root: FakeElement, html: string): void {
  const stack: FakeElement[] = [root];
  const tagPattern = /<\/?([a-zA-Z][\w-]*)((?:\s+[^\s=/>]+(?:="[^"]*"|='[^']*')?)*)\s*(\/?)>/g;
  let index = 0;
  for (const match of html.matchAll(tagPattern)) {
    const top = stack[stack.length - 1]!;
    if (match.index > index) addText(top, html.slice(index, match.index));
    index = match.index + match[0].length;
    const tag = (match[1] ?? "").toLowerCase();
    if (match[0].startsWith("</")) {
      while (stack.length > 1 && stack.pop()?.tagName !== tag) {
        // Unclosed elements end with their parent, as in a browser.
      }
      continue;
    }
    const element = new FakeElement(tag, root.doc);
    for (const attr of (match[2] ?? "").matchAll(/([^\s=/>]+)(?:="([^"]*)"|='([^']*)')?/g)) {
      element.setAttribute(attr[1] ?? "", decode(attr[2] ?? attr[3] ?? ""));
    }
    top.append(element);
    if (!VOID.has(tag) && match[3] !== "/") stack.push(element);
  }
  if (index < html.length) addText(stack[stack.length - 1]!, html.slice(index));
}

function addText(parent: FakeElement, raw: string): void {
  const node = new FakeText(decode(raw));
  node.parent = parent;
  parent.childNodes.push(node);
}

function decode(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}
