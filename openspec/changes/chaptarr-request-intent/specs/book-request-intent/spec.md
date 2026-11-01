## ADDED Requirements

### Requirement: Durable identity-bound single submission
The system SHALL keep one versioned book-only intent with independent HC work and author, exact format, immutable target fingerprint and canonical payload bytes. A dedicated local transaction SHALL commit prepared-to-sending exact-byte CAS before the single bounded producer POST. No external POST SHALL occur in ORM callbacks.

#### Scenario: Claim loses or transaction rolls back
- **WHEN** the exact prepared claim is lost, uncommitted or rolled back
- **THEN** no producer POST occurs.

#### Scenario: Result lost after admission
- **WHEN** a sending process crashes, loses its reply or receives malformed success
- **THEN** state stays sending until lease expiry or unknown; no retry/new intent/retarget/deletion escape is permitted.

### Requirement: Honest positive reconciliation and UI
The existing scheduled/manual Readarr scan SHALL dispatch and reconcile; no daemon is added. A 201 SHALL require fresh exact native/work/author/format validation before local linking. A 202 SHALL retain a separate pending handle without native availability. Unique positive inventory plus a fresh native read SHALL be the only reconciliation authority; misses and incomplete/ambiguous inventory stay held. UI SHALL display only finite safe state and disable unsafe retry.

#### Scenario: Pending accepted
- **WHEN** a typed camel/Pascal 202 pending response is received
- **THEN** the request remains approved, no native ID or availability is invented, and the next job only reconciles.

#### Scenario: Exact positive appears
- **WHEN** the original target yields one fresh verified native work and independent author in the requested format
- **THEN** only exact local native/service/slug fields are linked; completion waits for actual files.

### Requirement: Compatibility and preservation
The change SHALL add one nullable text column through SQLite/Postgres migrations. Stock Readarr/movie/TV and existing cleanup/removal/incomplete/unmapped/ambiguity guards SHALL remain. Prepared metadata SHALL use the pre-save snapshot or job-only resolution. Intent/root/payload bytes SHALL not be serialized to ordinary API/UI responses.

#### Scenario: Legacy request
- **WHEN** an existing approved facade request has no intent metadata snapshot
- **THEN** its committed row waits for job-only metadata resolution; no metadata POST happens in its callback.

### Requirement: Atomic admission retention across removals
The database SHALL refuse deleting any request carrying a non-null intent, including malformed envelopes, through direct, bulk or parent-FK-cascade removal. Intent preparation and deletion SHALL serialize in the database: deletion first prevents later preparation/claim, preparation first prevents deletion. Rollback SHALL refuse dropping an admission-bearing column. These holds require the reviewed migration; development synchronize alone is not migration execution.

#### Scenario: Parent media or requester removed
- **WHEN** a supported removal would cascade into an intent-bearing request
- **THEN** the database rejects the removal and retains exact admission bytes; a NULL-intent stock request remains removable.

#### Scenario: Mobile request card
- **WHEN** pending or unknown intent guidance is shown on either request-card branch
- **THEN** guidance sits outside responsive-hidden labels, without hiding it on mobile; actual viewport verification remains a release gate.

### Requirement: isolate admission from lifecycle writes
Ordinary ORM insert/save/update MUST NOT write bookRequestIntent, including stale null or nonnull entities. Dedicated preparation and exact-byte transitions alone write it with parameterized predicates. Status/owner saves MUST retain their ordinary subscriber behavior. Stale lifecycle saves MUST NOT erase a newer admission or remove the database deletion hold. Preparation may roll back with its originating transaction; dispatch claims MUST commit independently before POST.
