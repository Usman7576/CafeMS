// Email for staff notices. Every message is encrypted on its way to the mail server: the connection must
// switch to TLS 1.2 or later with a valid certificate, or nothing is sent and the message is retried
// later. Messages carry a reference only, never a customer's name, number or notes.
const nodemailer = require("nodemailer");

const SUBJECTS = Object.freeze({
  "reservation-request": "New online booking request"
});

function body(message, appOrigin) {
  if (message.type === "reservation-request") {
    return `A new online booking request (${message.payload.reservation}) is waiting.\n\nSign in to review it: ${appOrigin}/reservations.html\n\nThis message holds no guest details, by design.`;
  }
  return `Notice ${message.type}`;
}

function createMailNotifier(mail, appOrigin, fallback) {
  const transport = nodemailer.createTransport({
    url: mail.smtpUrl,
    // Plain SMTP must upgrade to TLS before anything is sent; smtps:// is encrypted from the start
    requireTLS: true,
    tls: { minVersion: "TLSv1.2", rejectUnauthorized: true, ...(mail.ca ? { ca: mail.ca } : {}) },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000
  });
  return {
    async deliver(message) {
      if (!Object.hasOwn(SUBJECTS, message.type)) return fallback.deliver(message);
      await transport.sendMail({ from: mail.from, to: mail.staffTo, subject: SUBJECTS[message.type], text: body(message, appOrigin) });
    },
    close: () => transport.close()
  };
}

module.exports = { createMailNotifier, SUBJECTS };
