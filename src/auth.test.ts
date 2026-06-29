import test from "node:test";
import assert from "node:assert/strict";
import {
  generateSessionToken,
  sessionExpiresAt,
  validateEmail,
  validatePassword,
} from "./auth.js";

test("generateSessionToken returns a 64-character hex token", () => {
  const token = generateSessionToken();
  assert.match(token, /^[a-f0-9]{64}$/);
});

test("sessionExpiresAt is about 30 days in the future", () => {
  const expiresAt = sessionExpiresAt().getTime();
  const deltaDays = (expiresAt - Date.now()) / 86_400_000;
  assert.ok(deltaDays > 29 && deltaDays < 31);
});

test("validateEmail normalizes valid addresses and rejects invalid ones", () => {
  assert.equal(validateEmail("User@Example.com"), null);
  assert.equal(validateEmail("not-an-email"), "Invalid email address.");
});

test("validatePassword enforces minimum length", () => {
  assert.equal(validatePassword("1234567"), "Password must be at least 8 characters.");
  assert.equal(validatePassword("12345678"), null);
});