# Rewardify Firestore Security Specification

## 1. Data Invariants
1. **Privilege Separation**: Regular users can NEVER assign `role: 'admin'`, create records in `/admins/{uid}`, or modify `status: 'suspended'` on their own user document.
2. **Wallet & Coin Integrity**: Users can NEVER directly credit their own `balance`, `coinBalance`, `totalDeposits`, `totalWithdrawals`, or `totalEarnings`. Wallet debits by a user are ONLY permitted atomically via `getAfter()` when purchasing an enabled plan in `/investments` or submitting a pending payout in `/withdrawalRequests` with sufficient balance.
3. **Immutable Ledger**: `/transactions` and `/auditLogs` cannot be updated or deleted by anyone (including admins).
4. **Payment Verification Lock**: Users can only create `/payments` with `status: 'created'` or `'pending'` and can NEVER set `status: 'completed'` or `verifiedBy`. Only verified Admin or backend verification can mark payments completed.
5. **Task Reward Anti-Duplication**: Users can only submit `/taskSubmissions` with `status: 'in_progress'` or `'submitted'` and `rewardCredited: false`. Only Admin can mark `'approved'` / `'completed'` and set `rewardCredited: true`.
6. **PII & Payout Protection**: `/users/{uid}`, `/bankDetails/{uid}`, and `/upiDetails/{uid}` are readable strictly by the owning UID or verified Admin.
10. **Server Timestamps**: All `createdAt` / `updatedAt` / `timestamp` fields must equal `request.time`.
11. **UPI Management & Analytics Isolation**: `/upiAccounts` management (create/update/delete) and all `/upiAnalytics` reads/writes are restricted strictly to verified Admins. Regular authenticated users can only list/read `active` UPI handles for deposit QR checkout and cannot read `upiAnalytics` or other users' `/upiAssignments`.
12. **Assignment Immutability**: `/upiAssignments` records cannot be deleted by anyone, preserving historical audit trails.

## 2. The "Dirty Dozen" Adversarial Payloads
1. **Self-Admin Escalation on User Create**: `{ uid: "u1", role: "admin", status: "active", ... }` -> `PERMISSION_DENIED`
2. **Self-Admin Escalation on User Update**: `{ role: "admin" }` by user `"u1"` -> `PERMISSION_DENIED`
3. **Unverified Email Write**: Any write by user with `email_verified: false` -> `PERMISSION_DENIED`
4. **Admin Email Spoof**: User claims `token.email: "lalit.kumar@oorjaa.tech"` with `email_verified: false` -> `PERMISSION_DENIED`
5. **Direct Wallet Coin Inflation**: User updates `/wallets/u1` with `{ coinBalance: 999999 }` without atomic investment/withdrawal -> `PERMISSION_DENIED`
6. **Self-Completed Payment**: User creates `/payments/p1` with `{ status: "verified", coinsToCredit: 5000 }` -> `PERMISSION_DENIED`
7. **Task Self-Approval**: User updates `/taskSubmissions/s1` with `{ status: "approved", rewardCredited: true }` -> `PERMISSION_DENIED`
8. **Shadow Field Injection**: User creates `/supportTickets/t1` with extra `{ isAdminOverride: true }` -> `PERMISSION_DENIED`
9. **Path ID Poisoning**: User writes `/supportTickets/<1500_char_junk>` -> `PERMISSION_DENIED`
10. **PII Cross-Read**: User `"u1"` reads `/users/u2` or `/bankDetails/u2` or `/upiAssignments/asg_other` -> `PERMISSION_DENIED`
11. **Unscoped List Query**: User `"u1"` runs `collection(db, 'transactions')` without `where('uid', '==', 'u1')` -> `PERMISSION_DENIED`
12. **Immutable Ledger & Analytics Tampering**: User tries to read/write `/upiAnalytics/upi_1` or delete `/upiAssignments/asg_1` -> `PERMISSION_DENIED`

