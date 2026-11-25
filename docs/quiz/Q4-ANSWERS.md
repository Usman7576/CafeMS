# Q4. Dependency Matrix, Graph and Failure Analysis (CafeMS: Staff Requests)

Analysis of the actual Q1–Q3 application: CafeMS with the Staff Requests workflow.

## A. Five system components

| Symbol | Component | Main responsibility |
| --- | --- | --- |
| C1 | Frontend (browser pages: login, Staff requests page) | Shows forms, lists and history; sends requests to the API with the session cookie; displays success, validation and conflict messages |
| C2 | Backend API (Express routes and workflow service) | Validates input, enforces the state machine Pending → In Review → Resolved/Rejected, version checks, filters, sorting and pagination |
| C3 | Authentication and authorization (JWT sessions and role guards) | Verifies password hashes and the signed JWT, checks the server session record, derives identity and role, returns 401/403 |
| C4 | Database (MongoDB replica set) | Stores users, sessions, staff_requests and request_history; unique index (owner + normalized title); transactions |
| C5 | Audit and history logger | Appends a history event (actor, record ID, action, old/new status, version, time) inside the same transaction as each change |

## B. Direct dependency matrix (row depends on column)

|  | C1 | C2 | C3 | C4 | C5 |
| --- | --- | --- | --- | --- | --- |
| C1 | 0 | 1 | 0 | 0 | 0 |
| C2 | 0 | 0 | 1 | 1 | 1 |
| C3 | 0 | 0 | 0 | 1 | 0 |
| C4 | 0 | 0 | 0 | 0 | 0 |
| C5 | 0 | 0 | 0 | 1 | 0 |

Reasons:
- C1 → C2: every page action is an API call.
- C2 → C3: every protected route runs the authentication and role guard first.
- C2 → C4: records are read and written in MongoDB.
- C2 → C5: each create or transition writes a history event in the same transaction.
- C3 → C4: users, password hashes and session records are read from MongoDB.
- C5 → C4: history and audit entries are stored in MongoDB.

## C. Directed dependency graph (arrow = depends on)

```
        C1 Frontend
            |
            v
        C2 Backend API
         /    |     \
        v     |      v
 C3 Auth      |    C5 Audit/History
        \     |      /
         v    v     v
          C4 Database
```

Edges: C1→C2, C2→C3, C2→C4, C2→C5, C3→C4, C5→C4 (6 edges, same as the 1s in the matrix).

## D. Failure analysis and mitigation

### 1. Database failure (C4 fails)

- **Direct effects:** C2 cannot read or save requests; C3 cannot check sessions or passwords; C5 cannot write history.
- **Indirect effects:** C1 cannot list, submit, claim or resolve; users cannot sign in or sign out.
- **Safe behaviour:** the API returns **503 "database unavailable, nothing was saved"**. Because each change and its history run in one transaction, there is no half-saved record and no false success.
- **Can continue safely:** static pages and the public site load; the liveness health check still answers; already-committed data stays safe on disk and returns when the database is back.

### 2. Authentication failure (C3 fails, or the token is missing, invalid or expired)

- **Must stop:** every protected operation. That means creating requests, listing, detail, history, claim/resolve/reject, and any staff page. The system fails closed with **401** (not signed in) or **403** (wrong role); it never guesses the user's identity or role.
- **Can continue safely:** public pages (home, menu, public reservation form), static files and health checks. Existing records and their history stay unchanged, because no write happens without a verified identity.

### 3. Critical component and recovery

- **Critical component: C4, the database.** It has the most dependents (C2, C3 and C5 depend on it directly, C1 indirectly), so it is the single point of failure. If it fails, every function stops.
- **Strategy: run MongoDB as a 3-node replica set with automatic failover** (`deploy/docker-compose.ha.yml`), together with encrypted daily backups (`npm run backup`) and a tested restore.
- **Why it is practical:**
  - If the primary node crashes, the other nodes elect a new primary in about 10 seconds, so the service keeps running without anyone stepping in.
  - The driver retries the transaction, and because writes use majority write concern, no committed data is lost.
  - Backups cover the worst case, such as data deleted by mistake or ransomware.
  - In the meantime the app shows 503 instead of partial saves.
