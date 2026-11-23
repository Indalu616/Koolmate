# Publishing "KoolMate for Blackboard"

**Live on Microsoft Edge Add-ons:** https://microsoftedge.microsoft.com/addons/detail/koolmate-for-blackboard/kaogdefmceapcfkdjlkjkiddbhcdckfo (approved 23 Nov 2026, version 1.0.0). Chrome Web Store: not submitted yet.

Everything below is ready to paste into the Chrome Web Store and Microsoft Edge Add-ons forms.

## 1. Build the upload file

```powershell
npm run pack:extension
```

This creates `release/koolmate-blackboard-1.0.0.zip`. Upload that zip to both stores. For every later update, raise `"version"` in `electron/extension/manifest.json` (for example `1.0.1`) and run the command again.

## 2. Accounts (one time)

| Store | Where | Cost |
|---|---|---|
| Chrome Web Store | https://chrome.google.com/webstore/devconsole | US$5 one-time registration fee |
| Microsoft Edge Add-ons | https://partner.microsoft.com/dashboard/microsoftedge | Free |

## 3. Store listing

**Name:** KoolMate for Blackboard

**Summary / short description (max 132 characters):**
Files your Blackboard downloads into the right course folder by telling the KoolMate desktop app which course they came from.

**Category:** Productivity (Edge: Productivity)

**Language:** English

**Detailed description:**

> Stop digging through your Downloads folder for lecture slides.
>
> KoolMate for Blackboard works together with the free KoolMate desktop app. When you download a file from a Blackboard course, such as "Week 11 - Design.pptx", the extension tells KoolMate which course it came from. KoolMate then:
>
> • puts it in that course's folder, for example "ITE409_HumanComputerInteraction", creating the folder if needed
> • reads the file to sort it into the right subfolder: LectureMaterials, Labs, Assignments or Activities
> • shows each step as it happens, with one-click Undo
>
> It even works when the file name says nothing about the course.
>
> Private by design: the course name and file name are sent only to the KoolMate app on your own computer (127.0.0.1). Nothing is sent to any server.
>
> Requires the KoolMate desktop app (Windows or macOS): https://github.com/Indalu616/Koolmate/releases

**Homepage / support URL:** https://github.com/Indalu616/Koolmate

**Privacy policy URL:** https://github.com/Indalu616/Koolmate/blob/main/PRIVACY.md (works once `PRIVACY.md` is pushed to GitHub)

## 4. Images you need to make

| Image | Size | Required by |
|---|---|---|
| Store icon | 128×128 | Both. Use `electron/extension/icon-128.png` |
| Screenshot(s) | 1280×800 (or 640×400) | Both, at least 1. Suggest: the KoolMate pop-up next to a Blackboard course page, and the extension pop-up showing "Connected" |
| Small promo tile | 440×280 | Chrome (optional but recommended) |

## 5. Privacy practices tab (Chrome) / Privacy section (Edge)

**Single purpose:**
Tell the KoolMate desktop app on the user's computer which Blackboard course a download came from, so the app can file it in that course's folder.

**Permission justifications:**

| Permission | Why it is needed |
|---|---|
| `downloads` | To notice when a download starts from Blackboard and learn its final file name, so the app can match the file to its course. The extension never opens, changes or deletes downloads. |
| `storage` | To remember which Blackboard course each tab shows, so a download can be matched to its course. Stored only in the browser. |
| `alarms` | To check every few minutes that the KoolMate desktop app is running, so the extension can show "Connected". |
| Host `https://*.blackboard.com/*`, `https://blackboard.adu.ac.ae/*` | To read the course name on Blackboard course pages. Not used on any other site. |
| Host `http://127.0.0.1:47613/*` | To send the course and file name to the KoolMate app on the same computer. This address is only reachable from the user's own machine. |

**Remote code:** No. All code is included in the package.

**Data usage (Chrome checkboxes):** The extension reads *website content* (the Blackboard course name) and handles download file names, but sends them only to the app on the user's own device. Nothing is sold or transferred to third parties, used for unrelated purposes, or used for creditworthiness. Tick the three certification boxes.

## 6. Notes for reviewers (paste into "Notes" / "Testing instructions")

> This extension is a companion to the open-source KoolMate desktop app (https://github.com/Indalu616/Koolmate). It only acts on Blackboard Learn course pages and only talks to the desktop app on 127.0.0.1:47613; it makes no other network requests.
>
> To test without a university Blackboard account: install the desktop app and run it, open the extension pop-up, and it shows "Connected to the KoolMate app". On any Blackboard course page (URL contains /ultra/courses/_123_1/), the pop-up shows the course name, and a download from that page is reported to the app, which files it into a course folder.

## 7. After approval

Paste the two store links into `electron/extensionLinks.js` (`chrome` and `edge`). The app's Settings page will then show "Add to Chrome" / "Add to Edge" buttons instead of the developer-mode steps.
