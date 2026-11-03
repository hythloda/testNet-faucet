# TestNet Faucet Requests

The public form at https://testnet-faucet.canton.foundation/ submits to the existing
Apps Script web app. The Monday backend saves requests to
[TestNet Faucet Requests](https://canton-foundation.monday.com/boards/18438203163)
in CF Operations. Operators process requests once daily Monday–Friday.

## Backend

Source: `apps-script/Code.gs`. Project:
https://script.google.com/home/projects/1o6bFa9UV9Fn_zJYnObLDz-GZEQZ5n0yaIuHtpW6QydCcB3JRgchz7pSt/edit

The existing production deployment URL is retained in `index.html`. Update that
existing deployment to a new version; preserve execute-as-owner and its existing
public form access. Do not create a replacement deployment with a different URL.

Set `MONDAY_API_TOKEN` in Apps Script's Script Properties. It needs read and item
creation/update access to board `18438203163`. The token stays on the server and
must never be included in this repository, the webpage, responses, or logs.

Run `verifyFaucetSetup` in the editor to verify board, group, and column access.
Run `installFaucetAutomation` once to install an idempotent 15-minute trigger for
notification retries and processing-time updates. Review the Google permissions
for external API requests, notification email, trigger management, and your own
email address. Administrative functions reject anonymous web-app callers.

The normal flow is:

1. Validate a positive integer CC amount and a nonempty PartyID. Requests above
   1000 CC require Usage, matching the website's existing rule.
2. Find an existing Monday item by the stable Request ID before creating a row.
   Retries with the same details reuse that row; conflicting details are rejected.
3. Save the request to New requests with Status New and Source Website.
4. Send the existing TestNet Faucet Response notification to
   `amanda@canton.foundation`, linking to the Monday item. A failed notification
   leaves the saved request intact and is retried by the private trigger handler.
5. Return an acknowledgement to the submitting webpage only after Monday confirms
   the save. The webpage validates its submission ID and the Apps Script message
   origin before showing thanks. Errors and timeouts keep the input for retry.

This workflow queues requests for existing manual processing; it does not transfer
CC. Imported history and authorized validation requests do not send notifications.
Processing Hours for new website requests updates when their status changes.

## History migration

The original Airtable table is `appTtVN4nqIaTA7CH/tbloCT1z18vC1i8mL`.
History is stored in Imported history with the original status, PartyID, amount,
Usage, Contact, requested time, last modification, processing hours, and Airtable
record ID. Legacy Fields preserves the exact original field JSON, including the
duplicate Created 2 field. Monday trims incidental outer spaces in text cells;
the unmodified originals remain in Legacy Fields.

Airtable record IDs make migration reconciliation idempotent. Reconcile any final
source changes at cutover. Never reset imported statuses or replay notifications.
The separate FA Enforcement table and its automations are outside this migration.

## Verification

Run `node --test tests/*.test.cjs` for the backend and browser acknowledgement tests.

For a live browser check, run `prepareFaucetWebTest` as the administrator in the
Apps Script editor. Open the one-use URL from the execution log and submit a test.
That pre-authorized ID expires after ten minutes and is saved in Validation with
Status Ignoring and Notification Suppressed. Public client flags cannot enable
this mode. Archive the validation item after verification.

For deployment, save the tested backend and manifest, update the existing Apps
Script deployment, verify its health response identifies the Monday backend, and
then publish the frontend to the repository's main branch (GitHub Pages).
