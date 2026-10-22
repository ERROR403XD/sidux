### Stop button activates promptly for new threads

#### Feature/Change Name
The composer stop control switches from the temporary saving spinner to a real stop button as soon as the active turn id is available for a newly created thread.

#### Prerequisites/Setup
1. Dev server running at `http://127.0.0.1:4173`
2. Home route available with a writable project/folder selected
3. Codex can start a normal assistant turn

#### Steps
1. Open `http://127.0.0.1:4173/#/`
2. Send a short prompt from the new-thread composer
3. While the first send is pending, invoke submit a second time
4. Immediately watch the right-side composer control after routing into the new thread
5. Before the full response finishes, verify the temporary saving spinner transitions into the stop icon/button
6. Click `Stop` while the turn is still running

#### Expected Results
- A new thread may briefly show the saving spinner while the turn starts
- The duplicate submit is ignored; only one new thread and one first-turn request are created
- The control becomes an actual stop button as soon as the active turn id is known, without waiting for thread-list persistence
- Clicking stop interrupts the running turn

#### Rollback/Cleanup
- Archive or delete the test thread if it was created only for this check

---
