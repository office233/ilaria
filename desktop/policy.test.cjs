const { test } = require("node:test");
const assert = require("node:assert/strict");
const { safeURL, validSender, clampBounds } = require("./policy.cjs");
test("remote apps cannot execute local protocols or receive URL credentials", () => {
  for (const value of [
    "file:///C:/Windows",
    "javascript:alert(1)",
    "https://user:pass@example.com",
    "http://example.com",
    "not a URL",
  ])
    assert.equal(safeURL(value), false);
  for (const value of ["https://swypik.com/go", "http://127.0.0.1:4848"])
    assert.equal(safeURL(value), true);
});
test("IPC is restricted to the exact shell webContents and main frame", () => {
  const frame = { url: "http://127.0.0.1:1234/" };
  const shell = { mainFrame: frame };
  assert.equal(
    validSender(
      { sender: shell, senderFrame: frame },
      shell,
      "http://127.0.0.1:1234",
    ),
    true,
  );
  assert.equal(
    validSender(
      { sender: {}, senderFrame: frame },
      shell,
      "http://127.0.0.1:1234",
    ),
    false,
  );
  assert.equal(
    validSender(
      { sender: shell, senderFrame: { url: frame.url } },
      shell,
      "http://127.0.0.1:1234",
    ),
    false,
  );
});
test("app bounds cannot cover outside the content window", () => {
  assert.deepEqual(
    clampBounds({ x: -3, y: 80, width: 2000, height: 900 }, [1000, 700]),
    { x: 0, y: 80, width: 1000, height: 620 },
  );
  assert.equal(
    clampBounds({ x: NaN, y: 0, width: 10, height: 10 }, [100, 100]),
    null,
  );
});
