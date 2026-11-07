# AOC Claim Spot Watcher

Chrome extension I made because spots on Arizona Outdoors Club trips fill up super fast and I kept missing them. It watches the trip signup pages and clicks "CLAIM SPOT" / "CLAIM PASSENGER SPOT" as soon as one opens up.

You can watch multiple events at once, each one gets its own tab.

## How it works

- Every event tab does a background fetch of its signup page (with your normal login cookies) and checks the HTML for a claim button. It waits 100ms after each response before sending the next one, so there's only ever one request going per event.
- The tab you see doesn't keep refreshing. When a button shows up in the fetched HTML, it reloads the real tab once, finds the actual button, and clicks it. Only one click per event.
- After the click the site shows a "Trip Safety Agreement" popup. The extension checks the "I acknowledge..." box and hits Proceed. Heads up: that means it accepts the agreement for you (and reaffirms the AOC liability waiver). If the popup has a different checkbox than that one, or Proceed doesn't enable within 5 sec, it doesn't touch it and gives you a desktop notification instead.
- If the request fails (network error, timeout, 408, 5xx) it retries with backoff (1s, 2s, 4s... up to 60s). For 429 it waits at least 60s. Login pages, captcha/challenge pages, and other errors just pause that event and send a notification.

## Setup

1. Make a file called `profile-email.txt` next to `Launch-Watcher.ps1` with just the email of your Chrome profile in it (the launcher uses it to find the right profile). It's in .gitignore so it won't get committed.
2. Double click `Install Watcher.cmd`. It opens chrome://extensions and copies the extension folder path to your clipboard.
3. Turn on Developer mode, click "Load unpacked", and pick the `extension` folder.
4. Pin it from the puzzle piece menu if you want.

## Usage

- Click the extension icon, type the event IDs (comma or newline separated, like `6421, 6228`), and click **Save & start all**.
- The badge shows how many events are running. You can stop one event or all of them from the popup. Pressing Escape on an event page or closing its tab also stops that event.
- `Start Watcher.cmd` opens Chrome and starts your saved list.
- The event list is saved, but watching stops when Chrome restarts so you have to start it again.

After updating the code, reload the extension in chrome://extensions and refresh any open event tabs (otherwise you get "Extension context invalidated" errors).

## Tests

```
node --test tests/*.test.cjs
```

There's also a browser test page. Run `python -m http.server 8765 --bind 127.0.0.1` and open http://127.0.0.1:8765/tests/browser-fixture.html. None of the tests send anything to the real site.

## Known issues / limitations

- Chrome throttles timers in background tabs, so checks in tabs you're not looking at can be way slower than 100ms.
- Clicking doesn't guarantee you got the spot. Always check the page.
- The silent check needs the "Car N:" / "Driver:" text on the page, so it can't watch an event before cars are posted.
- It only finds normal buttons/links (no iframes or shadow DOM). If the site changes its HTML this will probably break.
- Lots of events = lots of requests, so don't go crazy with it.

It doesn't store any passwords. It only has permission for arizonaoutdoorsclub.com and just uses the cookies Chrome already has.
