# Braiins Hashpower connection design

This design covers the operator-facing changes to the dual API implementation in `6a311f76`. The dashboard currently offers an API version dropdown during setup and separate credential editors in Config.

## First setup

Open with **Connect to Braiins Hashpower** and one masked field labeled **Braiins ID API key (v2)**. Explain where to create a key and how to choose access. Viewer can monitor an account. Admin can also place, change and cancel bids. [Braiins key permissions](https://academy.braiins.com/braiins-hashpower/api#what-a-key-can-do)

Show **Verify connection** beside the v2 field. After a successful account read, show **Connected to Acme Mining. Account read access verified.** Use the account ID if Braiins omits its display name. Editing the key clears that result. Completing setup starts Autopilot in **DRY-RUN**. Enabling LIVE is a separate operator action.

Keep **Use an existing legacy token (v1)** visible beneath the v2 field. Expanding it switches the form to **Owner token** and **Read-only token (optional)**, with a way back to the Braiins ID key. Submit only the selected credentials. This lets an operator reinstall with an existing token while keeping the first screen focused on the credential Braiins currently issues. [Braiins migration reference](https://academy.braiins.com/braiins-hashpower/api#migrating-from-v1)

## Existing installations

An ordinary upgrade preserves the active protocol and run mode. In **Config → Security & credentials**, show the current connection and the action available to the operator.

| Connection state | What the operator sees |
| --- | --- |
| v1 active | **Connected using a legacy token (v1)** and **Migrate to Braiins ID**. Existing token rotation remains available. |
| Migration saved, before restart | **v1 is active. Restart to activate v2.** Bid changes remain on hold. |
| v2 active | **Connected using Braiins ID (v2)** and **Rotate API key** for the bound account. |
| Credentials managed by environment or SOPS | Show the active version, the credential source and instructions for updating it there. |

For migration, explain the one-way database binding before saving. Select DRY-RUN and let an in-flight bid change finish. Enter the dashboard password, expected Braiins account ID and candidate key. Verify the account and available local history, then save. A failed check leaves the current credentials usable. After restart, ask the operator to review the balance and owned bids before choosing LIVE. A read-access check never submits a bid. [Migration procedure](../configuration.md#braiins-hashpower-api-version)
