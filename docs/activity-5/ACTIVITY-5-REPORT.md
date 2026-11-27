# Project Activity 5: Basic Secure Coding Implementation

**Project:** CafeMS, the cafe management system from our earlier activities (the same project, not a new app)
**Scope:** frontend security in HTML, CSS and JavaScript, plus one logout header on the server
**Evidence:** [test-results.json](test-results.json) and the screenshots in [screenshots/](screenshots/). Both are produced by
`node scripts/activity5-evidence.js`, which runs every test case in a real Chrome window.

## Where the changes are

| File | What it does |
| --- | --- |
| `public/js/validate.js` (new) | Shared form validation, file checks and the password strength display |
| `public/js/password_strength_helper.js` (new) | The instructor's file, copied unchanged (SHA-256 `539b97de…3191`, checked by a test) |
| `public/js/home.js`, `reservation.js`, `login.js`, `menu.js`, `users.js`, `account.js`, `setup.js`, `inventory.js`, `reports.js` | Each form now calls `Validate.attach(...)` and sends only checked, trimmed values |
| `public/js/common.js` | Safer `CMS.h` (blocks `javascript:` links and string event handlers); storage clean-up; `Session.wipe()` on sign-out |
| `public/js/store.js`, `app.js` | `Store.forget()` and `Session.wipe()` on sign-out or session end |
| `public/css/style.css` | Styles for field messages, the file status and the strength meter |
| `public/*.html` | Load `validate.js`; `account.html` and `setup.html` also load the helper |
| `server/routes/auth.js` | Sign-out answers with `Clear-Site-Data: "cache"` |
| `tests/activity5.test.js` (new) | 9 automated checks that keep these protections in place |
| `scripts/activity5-evidence.js` (new) | Runs the 28 test cases in Chrome and saves the results and screenshots |

---

## Task 1: Secure input validation

### Weaknesses found
- **Public reservation form (`index.html`):** it checked only that four fields were not empty, and showed one general message.
  There were no length, format or range checks in the browser. A mobile number like `12345`, a past date or 25 guests went to
  the server, which refused them.
- **Staff reservation form (`reservation.html`):** it showed one message at a time. It did not check the mobile number's format
  or the opening hours.
- **Menu item, staff member, sign-in, stock, refund and security-question forms:** no browser checks at all. Every mistake
  needed a round trip to the server.
- **Spaces:** text was not trimmed consistently in the browser. Doubled spaces inside names were kept.
- **`maxlength` only:** browsers apply `maxlength` to typing, but a value set in DevTools skips it. The scripts did not
  check lengths again.

### What was implemented
`Validate.attach(form, rules, { summary })` in `public/js/validate.js` does the following for every field:

1. **Removes leading and trailing spaces.** It also turns control characters into spaces and, for names, joins doubled
   spaces. The cleaned value is written back into the field, so the person sees exactly what is sent. Passwords are the only
   exception: a space can be part of a password, so they are never changed.
2. **Stops empty required fields from being sent** (`Your name is required.`). It also marks each one with
   `aria-required`.
3. **Applies minimum and maximum lengths** (`must be at least 2 characters`, `must be 160 characters or fewer`). It sets
   `minlength` and `maxlength` on the field, and checks the lengths again in the script in case those attributes were bypassed.
4. **Checks formats and ranges:**
   - names allow letters, spaces, `.`, `'` and `-` only
   - mobile numbers must be `03XXXXXXXXX` (spaces and dashes are removed first)
   - usernames must be 3–30 letters, numbers, dots or underscores, starting with a letter
   - dates must be real dates, not in the past, and at most 60 days ahead for online bookings
   - times must fall within opening hours, 10:00 to 23:00
   - numbers must be whole numbers within a range (guests 1–20, price Rs 50–20,000)
   - the new password must differ from the current one, and the confirmation must match
5. **Shows a message under each field** that needs fixing. The field is marked with `aria-invalid` and linked to its message
   with `aria-describedby`. A summary appears at the top of the form, and focus moves to the first problem. A field's message
   clears as soon as the field is fixed.

The rules use the same limits as the server's schemas (`server/lib/schemas.js`). The server still checks everything again,
because browser checks can be switched off.

| Form | Page | Fields and rules |
| --- | --- | --- |
| Online reservation | `index.html` | Name 2–60 (name format); mobile `03XXXXXXXXX`; date not past, ≤ 60 days ahead; time 10:00–23:00; guests 1–20; notes ≤ 160 |
| Staff reservation | `reservation.html` | Same rules as the online form, without the 60-day limit |
| Staff sign-in | `login.html` | Username required, 3–30, username format; password required, ≤ 128 |
| Menu item | `menu.html` | Name 2–40; category 2–24; price whole number Rs 50–20,000; description ≤ 80; photo (see Task 3) |
| Add staff member | `users.html` | Full name 2–60 (name format); username format; role must be on the list |
| Change password | `account.html` | Current password required; new password 12–128, all four character types, different from current |
| Security question | `account.html` | Question 10–100, no `<` or `>`; answer 3–100 |
| Choose a password | `setup.html` | Password 12–128, all four character types; confirmation must match |
| Restock or write off | `inventory.html` | Quantity 0.1–1000; reason 3–60 |
| Refund | `reports.html` | Reason 4–80 |

---

## Task 2: Cross-site scripting (XSS) prevention

### Components that display user-provided information
1. **Reservation notes and guest name** are typed by a member of the public on `index.html`. Staff see them in the
   reservation queue (`reservations.js`, the **View** dialog) and in the recent list (`reservation.js`). This is the main
   risk: anyone on the internet can write text that staff will later open.
2. **Menu item name and description** are typed by an Admin on `menu.html`. Every visitor sees them on the public menu
   (`home.js`).
3. Kitchen notes on orders, customer names and audit details are displayed the same way.

### How they were displayed, and unsafe DOM use found
Our earlier versions built screens with `innerHTML`:

| Commit | `innerHTML` uses in JS and HTML |
| --- | --- |
| `8a072ed` (first prototype) | 7 |
| `ab6c012` (v2.0) | 50 |
| `57d8978` (Activity 3) | 53 |

With `innerHTML`, a note such as `<img src=x onerror=alert(1)>` would have become a real element and run its script.
These were replaced in later phases. The current code builds every element with the helper `CMS.h(tag, attrs, children)`.
It puts text in with `textContent` or a text node only, so the browser treats the text as data, never as HTML.

For this activity we searched every file in `public/js` again. There are no `innerHTML`, `outerHTML`,
`insertAdjacentHTML` or `document.write` calls. A test (`tests/activity5.test.js`) fails if one is ever added.

We also examined `CMS.h` itself and found two gaps that could still be abused if stored data reached them:
- an `href` or `src` value of `javascript:alert(1)` would have been set as it was
- an `onclick` attribute given as a string was passed to `addEventListener`

### Safer rendering implemented
- **`CMS.h` checks link and image addresses.** In `href`, `src`, `action`, `formaction` and `xlink:href` it accepts only
  relative addresses, `http(s)`, `mailto`, `tel`, `blob` or image data URLs. Anything else, such as `javascript:` or
  `vbscript:`, becomes `about:blank#blocked`. Tabs and control characters are removed first, so `java\tscript:` is caught
  too.
- **Event handlers must be functions.** A string handler is ignored.
- **The browser blocks HTML strings as well.** The Content-Security-Policy includes `require-trusted-types-for 'script'`,
  so the browser itself throws an error if any script assigns a plain string to `innerHTML`. Inline scripts are also not
  allowed (`script-src 'self'`).
- **Uploaded photos cannot carry script.** They are served with `X-Content-Type-Options: nosniff` and a sandboxing CSP.

### Testing with malicious input
The inputs were typical XSS test strings. We did not have the instructor's own list, so these are standard examples:

| Where | Input |
| --- | --- |
| Reservation notes (public form) | `<img src=x onerror="window.__xss=1;alert('XSS')"> <script>window.__xss=2;alert('XSS')</script>` |
| Menu item name | `<script>alert(1)</script>` |
| Menu item description | `<svg onload=alert(document.cookie)> <b>bold?</b>` |
| Page console | `element.innerHTML = '<img src=x onerror=alert(1)>'`, `CMS.h('a', { href: 'javascript:alert(1)' })`, `CMS.h('button', { onclick: 'alert(1)' })` |

**Result:** every payload is shown literally as text (screenshots 08 and 15). No alert opened, `window.__xss` stayed unset,
and no `<img>`, `<script>`, `<svg>` or `<b>` element was created. The `innerHTML` assignment was refused with
`TypeError: … This document requires 'TrustedHTML' assignment` (TC-07, TC-08 and TC-19).

---

## Task 3: Secure file selection and validation

**Component:** the menu item **Photo** field on `menu.html` (Admin only).

### Weakness found
The field had `accept="image/png,image/jpeg,image/webp"`, and the label said "up to 2 MB". Nothing in the script enforced
either:
- `accept` only filters the file dialog, and "All files" bypasses it
- any file of any size was sent to the server, and only the server refused it

### What was implemented
`Validate.attachFile(input, rules)` checks the file the moment it is chosen, and again just before upload:

| Check | Rule | Message |
| --- | --- | --- |
| Extension | Only `.png`, `.jpg`, `.jpeg`, `.webp`. A hidden second extension such as `photo.php.png` is refused | `"setup.exe" is not an allowed file type. Choose a PNG, JPEG or WebP file.` |
| Type reported by the browser | `image/png`, `image/jpeg` or `image/webp` | `… does not look like a PNG, JPEG or WebP image.` |
| Size | More than 0 bytes and at most 2 MB, the same limit as the server (`photoBody: "2mb"`) | `"large-photo.png" is 3.00 MB. The largest file allowed is 2.00 MB.` |
| First bytes | The file must start with the real PNG, JPEG or WebP signature | `"not-really.png" is named .png but its contents are not a PNG image.` |
| File name length | 120 characters or fewer | `The file name is too long…` |

A refused file is removed from the picker, so it cannot be uploaded by mistake. An accepted file shows
`Ready to upload: flat-white.png (237 bytes)`.

**Important:** these checks are only a first screen. A file can still lie about its contents. That is why the server
decodes and rebuilds every image with `sharp`, removes its metadata, limits its pixel count, and serves it with
`nosniff`.

**Tested** (TC-20 to TC-27):
- refused: `.exe`, `.pdf`, a 3 MB file, a PHP script renamed `.png`, `photo.php.png` and an `.svg` with an `onload` script
- accepted: a real PNG, which was then uploaded and appeared as a thumbnail

---

## Task 4: Sensitive information handling

### What we examined
We looked at every use of `localStorage`, `sessionStorage`, IndexedDB and `document.cookie` in `public/js`, and at what
sign-out leaves behind.

**Earlier weaknesses.** The Activity 3 version (`57d8978`) kept the whole database in `localStorage`
(`cms_db_v4`): staff usernames, roles, orders and the audit log. It stayed on the device after the browser was closed.
It held no passwords, but it was unnecessary sensitive data. It was removed in a later phase. An existing line still
deletes old copies from any device that has one.

**Weaknesses found now:**
- `Session.set` wrote whatever object it was given into `sessionStorage`, so a later change could have stored a token by
  accident.
- Leftover keys from older versions, or from the console, were never cleaned up.
- Sign-out removed only the display copy, `cms_session`. The page's in-memory data, the refresh timer, the CSRF token in
  memory, open dialogs and filled forms all stayed until the page changed.
- After sign-out, the browser's Back button could show a cached page.

### What was implemented
- **Passwords are never stored in the browser.** They exist only in the password field until the request is sent, and the
  sign-in form clears the field afterwards. The session is an `HttpOnly`, `Secure`, `SameSite=Strict` cookie that no script
  can read (`document.cookie` is empty, TC-15).
- **`Session.set` keeps only four display fields:** `user`, `name`, `role` and `loginAt`. Anything else passed to it is
  dropped.
- **Storage is cleaned on every page load.** Only `cms_session` and `cms_flash` may stay in `sessionStorage`. Anything else
  is removed, and `localStorage` is cleared because the app keeps nothing there (TC-16).
- **No secret credentials or private keys in frontend code.** Server secrets (JWT, data, audit and gateway keys, database
  passwords) live only in server environment variables. A test scans every file in `public/`, and the browser run scans
  every script the page loads (TC-17).
  - The only private key in the browser is each device's own signing key. It is created as **non-extractable**, so no
    script, including ours, can read its value. It is kept for the next sign-in on that device, which is why sign-out does
    not delete it.
- **Sign-out clears the temporary interface state.** `Session.wipe()`:
  1. removes `cms_session` and the flash message
  2. clears the CSRF token held in memory
  3. cleans storage
  4. resets every form and clears password and code fields
  5. closes dialogs and removes notifications
  6. calls `Store.forget()`, which stops the refresh timer and drops the in-memory data, pending request keys and listeners

  The server ends the session, clears the cookie, and sends `Clear-Site-Data: "cache"` so cached pages are dropped. If a
  page comes back from the Back-button cache without a session, it sends the person to sign in (TC-18).

---

## Task 5: Password strength checker (bonus)

- `password_strength_helper.js` is copied unchanged into `public/js/`. A test checks its SHA-256 against the downloaded
  file.
- It is loaded on **`account.html`** (Change password) and **`setup.html`** (the page where new staff set their first
  password, or reset it).
- `Validate.attachStrength(input)` calls `checkPasswordStrength(password)` on every `input`, `change`, `paste` and `cut`.
  It shows the result directly below the password field: the level, the score out of 6, a six-part bar and the helper's
  message. The box hides again when the field is empty.
- The result is shown with `textContent`. The checker gives feedback only; the server still requires at least 12
  characters with all four character types, and refuses common passwords.

| Password | Shown | Score | Message from the helper |
| --- | --- | --- | --- |
| `abc` | Weak | 0 of 6 | Try using a longer password. |
| `password1` | Weak | 2 of 6 | Try using a longer password. |
| `Coffee2024` | Moderate | 3 of 6 | A longer password or more variety may improve it. |
| `Brew-House-58-Lantern!` | Strong | 6 of 6 | Good password pattern. Avoid reusing passwords. |

---

## Testing and demonstration

All 28 cases passed in Chrome. The table below is a summary; the full input, expected result and actual result of each case
are in [test-results.json](test-results.json), and the actual results there were read from the page during the run.

| # | Task | Feature | Input or action | Expected | Actual | Screenshot |
| --- | --- | --- | --- | --- | --- | --- |
| TC-01 | 1 | Online reservation | Required fields empty | Not sent; 4 messages | 4 messages, 0 requests sent | [01](screenshots/01-reservation-required-fields.png) |
| TC-02 | 1 | Online reservation | Name "A", mobile "12345", past date, 07:30, 25 guests, 170-character notes | 6 specific messages | 6 messages, 0 requests sent | [02](screenshots/02-reservation-invalid-formats.png) |
| TC-03 | 1 | Online reservation | Name "   Ayesha    Khan   ", mobile " 0321-1234567 " | Trimmed and accepted | Sent "Ayesha Khan" and "03211234567"; booking confirmed | [03](screenshots/03-reservation-typed-with-spaces.png), [04](screenshots/04-reservation-trimmed-accepted.png) |
| TC-04 | 1 | Staff sign-in | Both fields empty | 2 messages | 2 messages | [05](screenshots/05-login-required-fields.png) |
| TC-05 | 1 | Staff reservation | Name, mobile and time empty; party 0 | 4 messages | 4 messages | [06](screenshots/06-staff-reservation-invalid.png) |
| TC-06 | 1 | Staff reservation | Valid values | Messages clear; created | Created R-1002 | [07](screenshots/07-staff-reservation-valid.png) |
| TC-07 | 2 | Reservation queue | Notes with `<img onerror>` and `<script>` | Shown as text; nothing runs | Text only; 0 alerts; `__xss` unset | [08](screenshots/08-xss-reservation-notes-as-text.png) |
| TC-08 | 2 | Unsafe DOM APIs | `innerHTML`, `javascript:` link, string `onclick` | All refused | TrustedHTML error; link blocked; handler ignored | – |
| TC-09 to TC-12 | 5 | Strength checker | `abc`, `password1`, `Coffee2024`, `Brew-House-58-Lantern!` | Weak, Weak, Moderate, Strong | Weak, Weak, Moderate, Strong | [09](screenshots/09-strength-weak-3-characters.png), [10](screenshots/10-strength-weak-9-characters.png), [11](screenshots/11-strength-moderate-10-characters.png), [12](screenshots/12-strength-strong-22-characters.png) |
| TC-13 | 5 | Strength checker | Field emptied | Box hidden | Hidden | – |
| TC-14 | 1 | Change password | Current empty; new "short" | 2 messages | 2 messages | [13](screenshots/13-password-form-invalid.png) |
| TC-15 | 4 | Storage while signed in | Read both storages and `document.cookie` | No secrets; cookie hidden | Only `cms_session` display fields; cookie "" | – |
| TC-16 | 4 | Storage clean-up | Planted `password` and `authToken` | Removed on next page | Both removed | – |
| TC-17 | 4 | Secrets in JavaScript | Scan loaded scripts | None | None in 7 scripts | – |
| TC-18 | 4 | Sign-out | Sign out, then open a staff page | State cleared; back to sign-in | Storage empty; `/auth/me` 401; redirected | [14](screenshots/14-signed-out.png) |
| TC-19 | 2 | Public menu | `<script>` name; `<svg onload>` description | Shown as text | Text only; 0 elements; 0 alerts | [15](screenshots/15-xss-public-menu-as-text.png) |
| TC-20 | 3 | Menu photo | Real PNG | Accepted | "Ready to upload" | [16](screenshots/16-file-valid.png) |
| TC-21 to TC-26 | 3 | Menu photo | `.exe`, `.pdf`, 3 MB, fake `.png`, `photo.php.png`, `.svg` | Refused, with a message | All refused and cleared | [17](screenshots/17-file-exe.png)–[22](screenshots/22-file-svg.png) |
| TC-27 | 3 | Menu photo | Save with the real PNG | Uploaded | Thumbnail shown | [23](screenshots/23-file-valid-uploaded.png) |
| TC-28 | 5 | Strength on `setup.html` | `Coffee2024` | Moderate | Moderate | [24](screenshots/24-setup-strength-moderate.png) |

**How to repeat the tests:**

```bash
node scripts/activity5-evidence.js
```

```bash
node --test tests/activity5.test.js
```

The first command starts a throwaway copy of CafeMS on an in-memory database, so no real data is touched.

---

## Frontend controls are not the real enforcement

Every rule above can be switched off in someone's own browser, so the server enforces each one independently:

- **Input validation:** strict zod schemas refuse unknown fields, wrong types, wrong lengths and wrong formats
  (`server/lib/schemas.js`)
- **Authorisation:** checked on every request from the role in the signed session, never from what the page hides
- **Uploads:** size limit, type check, and the image decoded and rebuilt by `sharp`
- **Passwords:** 12–128 characters, all four character types, common passwords refused, stored only as Argon2id hashes
- **Sessions and storage:** the browser is never trusted; the session lives in an `HttpOnly` cookie and is checked by the
  server
