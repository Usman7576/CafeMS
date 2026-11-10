// Staff notice email is always encrypted in transit (Week 2, scenario 6)
const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const { SMTPServer } = require("smtp-server");
const selfsigned = require("selfsigned");
const { createMailNotifier } = require("../server/services/mailer");
const { loadConfig } = require("../server/config");
const { testEnv } = require("./helpers");

let cert;
before(async () => {
  cert = await selfsigned.generate([{ name: "commonName", value: "localhost" }], { days: 2, keySize: 2048, extensions: [{ name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }] }] });
});

// A real mail server on this machine. It records each message and whether the session was encrypted.
function mailServer({ tls }) {
  const received = [];
  const server = new SMTPServer({
    secure: false, authOptional: true, logger: false,
    ...(tls ? { key: cert.private, cert: cert.cert } : { disabledCommands: ["STARTTLS"] }),
    onData(stream, session, done) {
      const chunks = [];
      stream.on("data", (c) => chunks.push(c));
      stream.on("end", () => { received.push({ secure: session.secure, text: Buffer.concat(chunks).toString() }); done(); });
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, received, port: server.server.address().port }));
  });
}

const fallback = { delivered: [], deliver(m) { this.delivered.push(m); } };
const notice = { type: "reservation-request", payload: { reservation: "R-1001" } };
const mail = (port, ca) => ({ smtpUrl: `smtp://localhost:${port}`, from: "cafe@example.com", staffTo: "staff@example.com", ca });

describe("staff notice email", () => {
  const servers = [];
  after(() => servers.forEach((s) => s.server.close()));

  test("a notice is sent only after the connection switches to TLS, and holds no guest details", async () => {
    const s = await mailServer({ tls: true });
    servers.push(s);
    const notifier = createMailNotifier(mail(s.port, cert.cert), "https://cafe.example", fallback);
    await notifier.deliver(notice);
    notifier.close();
    assert.equal(s.received.length, 1);
    assert.equal(s.received[0].secure, true, "the session was encrypted");
    assert.match(s.received[0].text, /R-1001/);
    assert.doesNotMatch(s.received[0].text, /03\d{9}|phone|guest name/i);
  });

  test("a server that cannot encrypt receives nothing, and the message stays queued for a retry", async () => {
    const s = await mailServer({ tls: false });
    servers.push(s);
    const notifier = createMailNotifier(mail(s.port, cert.cert), "https://cafe.example", fallback);
    await assert.rejects(notifier.deliver(notice));
    notifier.close();
    assert.equal(s.received.length, 0, "nothing was sent in plain text");
  });

  test("a server whose certificate cannot be verified receives nothing", async () => {
    const s = await mailServer({ tls: true });
    servers.push(s);
    const notifier = createMailNotifier(mail(s.port, undefined), "https://cafe.example", fallback);
    await assert.rejects(notifier.deliver(notice));
    notifier.close();
    assert.equal(s.received.length, 0);
  });

  test("other notices keep their simulated delivery", async () => {
    const notifier = createMailNotifier(mail(1, cert.cert), "https://cafe.example", fallback);
    await notifier.deliver({ type: "receipt", payload: { billNo: "B-1" } });
    notifier.close();
    assert.equal(fallback.delivered.at(-1).type, "receipt");
  });

  test("only smtp:// or smtps:// mail settings are accepted, and an empty setting means mail is off", () => {
    const base = testEnv({});
    assert.throws(() => loadConfig({ ...base, SMTP_URL: "http://mail.example" }));
    assert.throws(() => loadConfig({ ...base, SMTP_URL: "smtp://mail.example" }), /MAIL_FROM/);
    assert.equal(loadConfig({ ...base, SMTP_URL: "", MAIL_FROM: "", STAFF_NOTIFY_EMAIL: "" }).mail, null);
    assert.ok(loadConfig({ ...base, SMTP_URL: "smtps://u:p@mail.example", MAIL_FROM: "a@example.com", STAFF_NOTIFY_EMAIL: "b@example.com" }).mail);
  });
});
