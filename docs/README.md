# Team documentation

Four kinds of document, each with one job. If you are not sure where something
belongs, it probably belongs in the design document instead.

| Document | Answers | Who writes it |
|---|---|---|
| [`hackrice-final-mvp-design.md`](../hackrice-final-mvp-design.md) | What are we building, and why is it shaped this way | Whoever changes the design, with the team's agreement |
| [`CHANGELOG.md`](CHANGELOG.md) | What landed, when, and does it require anything of me | The role that landed it |
| [`interfaces/`](interfaces) | How do I call the thing another role built | The role that owns the surface |
| [`pitfalls.md`](pitfalls.md) | What has already gone wrong here | Whoever hit it |
| [`supabase-setup.md`](supabase-setup.md) | How do I connect the hosted services | Role B |
| [`accounts.md`](accounts.md) | Signing in, membership, roles, and a workspace's life | Role B |
| [`handoff-b08.md`](handoff-b08.md) | Picking up Role B from B08 onward | Role B |
| [`../SETUP.md`](../SETUP.md) | How do I get running | Role B |

The design document is the specification and always wins. These describe an
implementation of it. Where they disagree, the design document is right and the
document you are reading is stale — say so rather than following it.

---

## The procedure

### When you land a ticket

1. **Add a CHANGELOG entry.** Ticket ID, date, commit, and an explicit
   **Action required** line — `None` is a perfectly good answer and saves three
   people from guessing.
2. **Update the interface file for anyone who consumes your work**, if the
   contract moved. Bump its `Reflects:` line to the ticket you just landed.
3. **Add to `pitfalls.md` if something bit you** in a way that would bite the
   next person. Write it as what happened, not as a rule.
4. **Amend the design document if you changed behaviour**, rather than leaving
   the code as the only record. That is the difference between a decision and a
   surprise.

### When you start a ticket

1. `git pull && npm install && npm run db:migrate`
2. Read the CHANGELOG from wherever you last left off. It is ordered
   newest-first, and every entry says whether it needs anything from you.
3. Read your interface file for the surfaces you are about to call.
4. Skim `pitfalls.md` once. It is short on purpose.

### When you need something another role owns

Do not reach into their directory. Define the interface in
`packages/contracts`, ship a null implementation so you are not blocked, and add
it to their interface file so they know it is waiting. This is how workspace
creation reaches the Git service and how Start reaches orchestration; both sides
built independently and integrated without a merge conflict.

---

## Currency

Every interface file opens with a `Reflects:` line naming the last ticket it was
checked against. If that is behind the CHANGELOG, treat the gap as unverified
and read the code.

No document here is generated. They drift unless someone updates them, which is
why step 2 above is part of landing a ticket rather than a cleanup task for
later.
