function safeURL(value) {
  try {
    const u = new URL(value);
    return (
      !u.username &&
      !u.password &&
      (u.protocol === "https:" ||
        (u.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)))
    );
  } catch {
    return false;
  }
}
function validSender(event, contents, origin) {
  return (
    event.sender === contents &&
    event.senderFrame === contents.mainFrame &&
    new URL(event.senderFrame.url).origin === origin
  );
}
function clampBounds(bounds, size) {
  if (
    !bounds ||
    !["x", "y", "width", "height"].every((k) => Number.isFinite(bounds[k]))
  )
    return null;
  const x = Math.max(0, Math.min(size[0], Math.round(bounds.x)));
  const y = Math.max(0, Math.min(size[1], Math.round(bounds.y)));
  return {
    x,
    y,
    width: Math.max(0, Math.min(size[0] - x, Math.round(bounds.width))),
    height: Math.max(0, Math.min(size[1] - y, Math.round(bounds.height))),
  };
}
module.exports = { safeURL, validSender, clampBounds };
