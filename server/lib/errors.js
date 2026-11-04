// Errors the user may see. Anything else becomes a generic message plus a request ID.
class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
    this.expose = true;
  }
}

const notSignedIn = () => new AppError(401, "not_signed_in", "Please sign in to continue.");
const forbidden = () => new AppError(403, "forbidden", "You do not have permission to do that.");
const invalidInput = () => new AppError(400, "invalid_input", "Check the information you entered and try again.");

module.exports = { AppError, notSignedIn, forbidden, invalidInput };
