# Cafe Management System (CMS): Frontend Prototype

A secure, web-based Cafe Management System built as the semester project for **Secure Software Development (SSD)**.
This repository holds **Development Activity 1**: a working, hosted frontend prototype designed around the **Waiter** role.

> **Live demo:** _add your public URL here_

## Pages

| Page | File | Description |
|---|---|---|
| Home / landing | `index.html` | System name, purpose, problem & solution, the 9 core modules, user roles, security requirements (SR-1 to SR-8), navigation and footer. |
| Staff sign in | `login.html` | Username + password only (roles are assigned by the server). Validation, password rules checklist, show/hide password, Caps Lock warning, lockout after 5 failed attempts. |
| Waiter dashboard | `dashboard.html` | Shift KPIs, *My orders* with status filters, *Ready to serve* queue, table status map, unavailable items. |
| Take order | `order.html` | Table picker, menu search + category filter, order ticket with quantity steppers and live totals (16% tax), kitchen notes, confirmation modal. |
| Not found | `404.html` | Custom 404 page (used automatically by Netlify / GitHub Pages). |

**Flow:** Home → Staff sign in → Dashboard ⇄ Take order → Sign out

## Trying the demo

The backend isn't built yet, so sign-in is simulated. Any username (3–30 characters, starting with a letter) and a password with 8+ characters, upper- and lower-case letters and a number will sign you in as a **Waiter**. **Don't use a real password.**

The kitchen is simulated too: a new order moves from *Placed* to *Preparing* after ~8 s, then to *Ready* after ~16 s more. Demo data is kept in `sessionStorage` and is cleared when you sign out.

## Security-aware design (frontend)

- No role selector at sign-in. The waiter UI exposes no billing, inventory, pricing, reports or admin functions.
- Only the minimum data is collected. No customer contact or payment details appear on waiter screens, and other staff's orders are hidden (their tables show only as *Other staff*).
- The password is never stored. The form uses `POST` and can't be submitted before its script loads, so credentials never end up in the URL.
- All user-entered text is rendered with `textContent`, never `innerHTML`, so HTML/script input is displayed as plain text.
- Generic sign-in errors, a simulated lockout after 5 failures, and auto sign-out after 5 minutes idle with a 30-second warning.

> Hiding a button is **not** a security control. Real authentication (bcrypt/Argon2), server-side RBAC on every request, input validation, HTTPS and audit logging will be enforced by the backend later in the semester.

## Tech

Plain HTML5, CSS3 and vanilla JavaScript with no build step. Inter font and an inline SVG icon set (Lucide-style, MIT).

```
index.html  login.html  dashboard.html  order.html  404.html
css/style.css          design system + all components
js/icons.js            inline SVG icons
js/common.js           DOM helper, toasts, modals, confirm dialog, session
js/store.js            prototype data layer + kitchen simulation
js/app.js              staff app shell: guard, sidebar, menus, idle timeout
js/login.js  js/dashboard.js  js/order.js
assets/favicon.svg
```

## Run locally

```bash
python -m http.server 8000
```

Then open http://localhost:8000.

## Deploy

- **Netlify:** drag the project folder onto https://app.netlify.com/drop.
- **GitHub Pages:** push to a public repo → *Settings → Pages → Deploy from branch → `main` / root*.

## Team

| Name | Roll No. | Role |
|---|---|---|
| M. Usman | 22L-7991 | Team Lead |
| _[Member]_ | _[Roll no.]_ | Backend |
| _[Member]_ | _[Roll no.]_ | Frontend |
| _[Member]_ | _[Roll no.]_ | Security / Testing |
