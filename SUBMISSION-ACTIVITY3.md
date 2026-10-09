# Development Activity 3 — Parallel Module Development and Integration

## Part 1: Project and module selection

**Project Name:** Cafe Management System (CMS)

**Group Members:** M. Usman (22L-7991)

**Module 1:** Create Reservation  
**Module 2:** Reservation Queue and Status Tracking

These modules are complementary: the first captures a new guest reservation, while the second provides the operational view needed to find arrivals and manage their lifecycle. They extend the existing waiter/manager workflow without duplicating order, billing, inventory, or kitchen functions.

### Module responsibilities

**Module 1 — Create Reservation**

- Capture guest name, mobile number, reservation date/time, party size, and optional notes.
- Validate required fields, phone format, date, time, party-size range, and note length.
- Prevent an active duplicate reservation for the same guest, date, and time.
- Save the reservation through the shared `Store` data layer and display recent records.

**Module 2 — Reservation Queue**

- Display all reservations with reference, guest, contact, date/time, party size, and status.
- Search by reference, guest name, or phone number.
- Filter by date and status.
- Open details and change an active reservation to Confirmed, Seated, Completed, or Cancelled.
- Show summary counts and feedback after a successful status change.

## Part 2: Member 1 — Module 1 implementation

**Responsible Group Member:** M. Usman (22L-7991)

**Primary function:** Create a table reservation from `reservation.html`.

**Input validation rules:**

- Guest name: 2–60 characters.
- Mobile: Pakistani `03XXXXXXXXX` format after spaces/hyphens are removed.
- Date: valid date and not earlier than today.
- Time: valid time between 10:00 and 23:00.
- Party size: whole number from 1 to 20.
- Notes: optional, maximum 160 characters.
- An active reservation with the same guest phone, date, and time is rejected.

**JavaScript interaction:** `js/reservation.js` submits the form through `Store.addReservation`, resets the form after success, shows a toast, and refreshes the recent-reservations list through `Store.on`.

**Feedback and data display:** Validation errors are shown in an accessible error alert. Successful submissions show a confirmation toast and appear immediately in the recent-reservations panel.

## Part 3: Member 2 — Module 2 implementation

**Responsible Group Member:** _[member name / roll no.]_

**Primary function:** Search, filter, inspect, and update reservation records from `reservations.html`.

**Input validation/search rules:**

- Search is case-insensitive and checks reference, guest name, and phone.
- Date filtering matches the selected reservation date.
- Status filtering matches one of the four supported statuses.
- Closed reservations (Completed or Cancelled) cannot be changed.
- The Store validates the requested status before saving it.

**JavaScript interaction:** `js/reservations.js` re-renders the table as search/filter controls change, opens a detail modal, and saves a status transition through `Store.updateReservation`.

**Feedback and data display:** The table shows an empty-state message when filters have no results. Successful changes show a toast and update the counts/table immediately. Invalid transitions are displayed through the shared error handler.

## Part 4: Integration

- Added `reservation.html` and `reservations.html` to the existing CafeMS folder.
- Added both pages to the role-protected navigation in `js/app.js`.
- Waiters and Managers can access both modules; other roles are redirected by the existing page guard.
- Both pages use the existing CafeMS shell, Inter typography, buttons, panels, inputs, pills, modals, icons, toasts, session guard, and responsive layout.
- Reservations are part of the existing Store state. They persist in `localStorage` for offline use and synchronize through the existing MongoDB API when the app is served with `npm start`.
- Existing pages continue using the same state and role guards.

## Part 5: Testing

| Test case | Expected result | Actual result |
|---|---|---|
| Submit a complete reservation | Reservation is accepted, a success message appears, and the record is listed | Pass |
| Leave guest name empty | Submission is blocked and a validation error appears | Pass |
| Enter an invalid phone/date/party size | Submission is blocked with a specific error | Pass |
| Submit the same guest/time twice | Second active duplicate is rejected | Pass |
| Search by guest or reservation reference | Only matching rows remain | Pass |
| Filter by date and status | Table updates to matching records | Pass |
| Change Confirmed to Seated/Completed | Status saves, toast appears, counts refresh | Pass |
| Change a Completed/Cancelled reservation | Save control is disabled and record remains unchanged | Pass |
| Open reservation pages as Cashier/Kitchen/Admin | Existing role guard denies access and redirects home | Pass |
| Navigate between dashboard, create page, and queue | Local links open the correct page | Pass |

**Module 1 issue discovered:** A duplicate guest could initially be entered for the same time slot.

**Module 2 issue discovered:** Closed reservations could be presented as editable if their detail modal was opened.

**Correction made:** Duplicate detection now runs in `Store.addReservation`, and both the UI and `Store.updateReservation` prevent changes to Completed/Cancelled records.

## Part 6: Security-aware development

| Module | Possible misuse or problem | Proposed response implemented |
|---|---|---|
| Create Reservation | Incomplete or unexpected values could create unusable records; duplicate bookings could overbook the floor. | Required-field validation, strict lengths/formats/ranges, past-date rejection, duplicate detection, text-only DOM rendering, and audit logging. |
| Reservation Queue | A user could expose guest contact information or alter a closed record. | Access is limited to Waiter/Manager roles, the phone is shown only inside the protected staff workspace, statuses are allow-listed, closed records cannot change, and every status change is audit logged. |

Frontend controls improve the prototype but are not a real security boundary. A production backend must repeat authentication, RBAC, validation, rate limiting, and audit enforcement server-side.

## Submission summary

**Project Name:** Cafe Management System (CMS)

**Module 1 functionality implemented:** Validated reservation creation with duplicate prevention, feedback, shared state, and recent-record display.

**Module 2 functionality implemented:** Reservation search/filter, detail view, status transitions, closed-record protection, summary counts, and feedback.

**JavaScript interactions implemented:**

1. Form validation and reservation creation through the shared Store.
2. Queue search/filtering and controlled status updates through the detail modal.

**One problem discovered during testing:** Duplicate reservations and closed-record edits were possible in early UI-only handling.

**How it was corrected:** Both rules were moved into the shared Store as well as the UI, so direct calls and future screens receive the same validation.

## Deliverables

- Updated HTML, CSS integration, JavaScript, and shared Store source.
- Both functional modules integrated into the existing role-based application.
- This completed Activity 3 testing and security-awareness record.
- Screenshots can be captured locally from `reservation.html` and `reservations.html` after signing in as `m.usman` or `sara.khan`.
