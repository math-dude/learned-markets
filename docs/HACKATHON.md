# UBC 2026 Hackathon

## Planned entry and deadlines

- **Project:** Learned Markets, an experimental Solana exchange that explores how learned liquidity provision could improve memecoin trading.
- **Main track:** DeFi and Onchain Applications.
- **Chain award:** Best use of Solana. Devpost accepts one main track and at most one chain award.
- **Sponsor bounty:** Best Use of QuickNode Streams, pending a qualifying integration.
- **Submit:** Friday, November 20, 2026 at **noon CST** on [Devpost](https://ubc-hackathon-2026.devpost.com/). Finalists are notified by 11:59 p.m. CST that day.
- **Finals:** Saturday, November 21 at UT Austin. Finalists have four minutes to present and two minutes for Q&A. The guide requires teams to be present in person at the closing ceremony for prize eligibility.

See the [official hackathon guide](https://docs.google.com/document/d/1QaySCo7u3VxMVNdk3C5Ab3ewc2E46AuLntti-Uzx5EY/edit) and the [UBC event page](https://www.universityblockchain.org/programs/hackathon).

## Technical requirements

| Entry | What to show and document |
| --- | --- |
| DeFi and Onchain Applications | Show the prototype interacting with smart contracts. Explain its economic design and risk assumptions in the README, and list the addresses of the contracts it deploys or uses. |
| Best use of Solana | Build the core onchain functionality on Solana. Devnet and existing programs are allowed. Explain which core actions use Solana and include the program IDs used by the submitted build. |
| QuickNode Streams | Use Streams as a core data source. Configure at least one Stream with a filter and destination. Document the network, dataset, filter logic, destination, and why the prototype depends on that data. |

See the [official hackathon guide](https://docs.google.com/document/d/1QaySCo7u3VxMVNdk3C5Ab3ewc2E46AuLntti-Uzx5EY/edit) for the full requirements and the [workshop schedule](https://docs.google.com/document/d/1eI8S0gBu6xI36DFqgqGZlO1qX6YYzFTEXBx9L5ve_zA/edit) for sponsor resources.

## Submission checklist

Status reflects the checkout reviewed on November 20. The [README](../README.md) and [development guide](DEVELOPMENT.md) contain starter setup instructions. The checked-in Anchor program exposes counter instructions. Verify the submission against the actual demo build.

- [ ] Enter the project name, short description, team members, main track, chain award, qualifying bounties, and technologies or sponsor tools used.
- [ ] Answer the Devpost prompts covering what we built, the problem, how it works, what makes it unique, and what we would build next.
- [ ] Link the public source repo and verify that a judge can access it and follow the setup instructions for the submitted build.
- [ ] Update the README with the prototype architecture, economic design, risk assumptions, Solana program IDs, and QuickNode configuration if entering the bounty.
- [ ] Verify a working demo or deployed application. Record what runs onchain and which parts use simulation or replay.
- [ ] Link a 2–3 minute demo video on YouTube or Google Drive that shows the prototype in action. Check that judges can open it.
- [ ] Confirm who will attend the closing ceremony in person and who will present if shortlisted.

## Demo and judging

Use one verified market scenario throughout the demo. Lead with the trader’s problem and show the user flow for **product and UX**. Trace a core action through the prototype and show its Solana transaction for **technical execution**. Explain which market rule or learned behavior is novel for **innovation**. For **impact and potential**, state what the observed result supports and what still needs testing. If entering the QuickNode bounty, show the incoming stream event and the feature it powers. Use the available time to show the working path end to end.

Use the same scenario for the four-minute finalist pitch, with program IDs, assumptions, and prototype limitations ready for the two-minute Q&A. See the judging criteria and pitch format in the [official hackathon guide](https://docs.google.com/document/d/1QaySCo7u3VxMVNdk3C5Ab3ewc2E46AuLntti-Uzx5EY/edit).

## Open eligibility question

UBC lists the start as November 12 at 6 p.m. CST. The Devpost rules repeat that time in the schedule and also exclude work created before November 13. The initial README commit (`c49c74e`, 6:06 p.m. CST) and scaffold commit (`d17d029`, 7:00 p.m. CST) both fall on November 12 after kickoff. Organizer clarification is pending on whether that work may be included in the submission. Record the determination here once confirmed. [UBC event page](https://www.universityblockchain.org/programs/hackathon) · [Devpost rules](https://ubc-hackathon-2026.devpost.com/rules)
