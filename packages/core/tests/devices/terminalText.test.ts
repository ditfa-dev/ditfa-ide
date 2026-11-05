import { describe, expect, it } from "vitest";

import {
  AnsiStream,
  OutputTail,
  REDACTED,
  RingBuffer,
  collapseCarriageReturns,
  fitOutputs,
  redactSecrets,
  stripAnsi,
  tailLines,
} from "@ditfa-ide/core/devices/terminalText";

describe("stripAnsi", () => {
  it("removes colors, cursor moves and shell-integration markers", () => {
    const raw =
      "\u001b]633;C\u0007\u001b[1;32mPASS\u001b[0m src/a.test.ts\n\u001b[2K\u001b[1A\u001b[?25lFAIL\u001b]633;D;1\u0007\n";
    expect(stripAnsi(raw)).toBe("PASS src/a.test.ts\nFAIL\n");
  });

  it("removes OSC strings ended by ESC \\ and two-byte escapes", () => {
    expect(stripAnsi("\u001b]0;title\u001b\\a\u001b(Bb\u001b=c\u001b7d")).toBe("abcd");
  });

  it("keeps tabs, newlines and carriage returns but drops other control characters", () => {
    expect(stripAnsi("a\tb\r\nc\u0007d\u0000e\u0008")).toBe("a\tb\r\ncde");
  });

  it("keeps plain text and unicode as it is", () => {
    expect(stripAnsi("✓ 12 tests passed — 3.1s")).toBe("✓ 12 tests passed — 3.1s");
  });
});

describe("AnsiStream", () => {
  it("holds back an escape sequence split across chunks", () => {
    const stream = new AnsiStream();
    expect(stream.push("ok \u001b[3")).toBe("ok ");
    expect(stream.push("2mgreen\u001b[0m done")).toBe("green done");
  });

  it("holds back an unfinished OSC marker", () => {
    const stream = new AnsiStream();
    expect(stream.push("a\u001b]633;D")).toBe("a");
    expect(stream.push(";0\u0007b")).toBe("b");
  });

  it("flushes a dangling escape as nothing harmful", () => {
    const stream = new AnsiStream();
    expect(stream.push("x\u001b")).toBe("x");
    expect(stream.flush()).toBe("");
  });
});

describe("collapseCarriageReturns", () => {
  it("keeps what a progress bar finally showed", () => {
    expect(collapseCarriageReturns("Downloading 10%\rDownloading 50%\rDownloading 100%\nDone\r\n")).toBe(
      "Downloading 100%\nDone\n",
    );
  });

  it("leaves text without carriage returns alone", () => {
    expect(collapseCarriageReturns("a\nb")).toBe("a\nb");
  });
});

describe("tailLines", () => {
  const text = "1\n2\n3\n4\n5\n";

  it("returns the last lines without the trailing newline", () => {
    expect(tailLines(text, 2)).toBe("4\n5");
  });

  it("returns everything when asked for more lines than there are", () => {
    expect(tailLines(text, 50)).toBe("1\n2\n3\n4\n5");
  });

  it("returns nothing for zero lines or empty text", () => {
    expect(tailLines(text, 0)).toBe("");
    expect(tailLines("", 5)).toBe("");
  });
});

describe("OutputTail", () => {
  it("strips escape codes as chunks arrive", () => {
    const tail = new OutputTail();
    tail.append("\u001b[31mer");
    tail.append("ror\u001b[0m\n");
    tail.end();
    expect(tail.read()).toBe("error");
  });

  it("keeps only the last characters, starting at a whole line", () => {
    const tail = new OutputTail(20, 100);
    for (let index = 0; index < 50; index += 1) tail.append(`line ${index}\n`);
    expect(tail.truncated).toBe(true);
    const lines = tail.read().split("\n");
    expect(lines.at(-1)).toBe("line 49");
    expect(lines.every((line) => /^line \d+$/.test(line))).toBe(true);
    expect(tail.read().length).toBeLessThanOrEqual(20);
  });

  it("keeps only the last lines", () => {
    const tail = new OutputTail(10_000, 3);
    tail.append("a\nb\nc\nd\ne\n");
    expect(tail.read()).toBe("c\nd\ne");
  });
});

describe("RingBuffer", () => {
  it("drops the oldest item past its capacity", () => {
    const ring = new RingBuffer<number>(3);
    for (const value of [1, 2, 3, 4, 5]) ring.push(value);
    expect(ring.toArray()).toEqual([3, 4, 5]);
    expect(ring.size).toBe(3);
    expect(ring.last()).toBe(5);
  });

  it("finds the newest matching item", () => {
    const ring = new RingBuffer<{ id: number; even: boolean }>(5);
    for (const id of [1, 2, 3, 4, 5]) ring.push({ id, even: id % 2 === 0 });
    expect(ring.findLast((item) => item.even)?.id).toBe(4);
    expect(ring.findLast(() => false)).toBeUndefined();
  });

  it("refuses a capacity that is not a positive integer", () => {
    expect(() => new RingBuffer(0)).toThrow(RangeError);
    expect(() => new RingBuffer(1.5)).toThrow(RangeError);
  });
});

describe("fitOutputs", () => {
  const commands = [
    { command: "a", output: "a1\na2\na3" },
    { command: "b", output: "b1\nb2" },
    { command: "c", output: "c1\nc2\nc3\nc4" },
  ];

  it("gives the newest command its lines first and keeps run order", () => {
    expect(fitOutputs(commands, 5)).toEqual([
      { command: "b", output: "b2" },
      { command: "c", output: "c1\nc2\nc3\nc4" },
    ]);
  });

  it("keeps every command when the budget allows", () => {
    expect(fitOutputs(commands, 100).map((command) => command.output)).toEqual(["a1\na2\na3", "b1\nb2", "c1\nc2\nc3\nc4"]);
  });

  it("cuts very long lines and caps the total characters", () => {
    const long = [{ command: "x", output: "y".repeat(5000) }];
    expect(fitOutputs(long, 10, 50_000, 100)[0]?.output).toBe(`${"y".repeat(100)}…`);
    expect(fitOutputs(long, 10, 30)[0]?.output.length).toBe(30);
  });
});

describe("redactSecrets", () => {
  it("keeps the name and hides the value of key=value secrets", () => {
    expect(redactSecrets("OPENAI_API_KEY=abc123def")).toBe(`OPENAI_API_KEY=${REDACTED}`);
    expect(redactSecrets("export GITHUB_TOKEN=xyz")).toBe(`export GITHUB_TOKEN=${REDACTED}`);
    expect(redactSecrets("db password: hunter2 ok")).toBe(`db password: ${REDACTED} ok`);
    expect(redactSecrets('{"client_secret": "s3cr3t", "user": "me"}')).toBe(`{"client_secret": "${REDACTED}", "user": "me"}`);
    expect(redactSecrets("api-key = 'k-1'")).toBe(`api-key = '${REDACTED}'`);
  });

  it("hides well-known token shapes anywhere", () => {
    const cases = [
      "sk-proj-AbCdEfGhIjKlMnOpQrStUvWx",
      "sk-ant-api03-AbCdEfGhIjKlMnOpQrSt",
      "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123",
      "github_pat_11AbCdEfGhIjKlMnOpQrSt_uvw",
      "dt-AbCdEfGhIjKlMnOpQrSt",
      "AKIAIOSFODNN7EXAMPLE",
      "xoxb-1234567890-abcdefghij",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    ];
    for (const token of cases) {
      expect(redactSecrets(`using ${token} now`), token).toBe(`using ${REDACTED} now`);
    }
  });

  it("hides bearer headers, URL passwords and private keys", () => {
    expect(redactSecrets("Authorization: Bearer abc.def")).toBe(`Authorization: Bearer ${REDACTED}`);
    expect(redactSecrets("postgres://app:pa55@db:5432/x")).toBe(`postgres://app:${REDACTED}@db:5432/x`);
    expect(redactSecrets("-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----\nafter")).toBe(
      "[redacted private key]\nafter",
    );
  });

  it("leaves ordinary output alone", () => {
    const text = [
      "Total tokens: 1500",
      "PWD=/Users/me/project",
      "tokenizer: bpe",
      "secrets: 3 found",
      "✓ src/auth/token.test.ts (4 tests)",
      "https://example.com/path",
      "task-runner done",
    ].join("\n");
    expect(redactSecrets(text)).toBe(text);
  });

  it("does not redact twice", () => {
    const once = redactSecrets("TOKEN=abc");
    expect(redactSecrets(once)).toBe(once);
  });
});
