# Editor guide

This guide is for members of the parish social media team. You don't need any
technical knowledge: everything happens in the web editor.

## Opening the editor

Go to **https://parishsandbox.github.io/social-media-pipeline/admin/** and sign in.
Bookmark it, or add it to your phone's home screen.

You will see a list of **Social Posts**, sorted by date. Use **Filter** to show,
for example, only posts that **Need writing** or **Have a problem**, and
**Group** to group them by status or month.

## Writing a post

1. Click **New Post** (or open an existing draft).
2. Fill in:
   - **Title**: a short name for the team, e.g. "St Nicholas". It is not posted.
   - **Publish date & time**: when it should go out (parish local time).
   - **Post to**: Facebook, Instagram, or both.
   - **Caption**: the text exactly as it should appear, including hashtags.
   - **Images** (optional): upload one or more pictures and describe each one
     briefly (alt text). **Instagram posts need at least one image.**
   - **Link** (optional): a YouTube video, livestream or web page. It is added
     to the end of the caption.
   - **Files** (optional): a PDF bulletin or flyer. A download link is added to
     the caption.
   - **First comment** (optional): posted as the first comment.
   - **Team notes**: private notes. Never posted.
3. Click **Save**.

The editor names the file after the date and title for you, e.g.
`2026-12-06-st-nicholas.md`.

## Statuses

| Status | What it means | What to do |
| --- | --- | --- |
| 📝 **Draft** | Being written | Write the caption and add an image |
| 👀 **Ready for review** | Waiting for a second pair of eyes | Reviewer: read it, fix it, approve it |
| ✅ **Approved** | Ready to go out | Nothing. It is scheduled automatically |
| 📅 **Scheduled** | Queued in Buffer (set automatically) | Edits are still sent to Buffer |
| 📣 **Published** | It has gone out (set automatically) | Nothing |
| 🚫 **Canceled** | Will not be posted | Nothing |

Approved posts are sent to Buffer two weeks before their publish time. A post
for December 25 approved in October stays **Approved** until about December 11,
then becomes **Scheduled**. Within a few minutes of saving, the **Automation
messages** box tells you when this will happen.

## Changing or stopping a scheduled post

- **To change it**, edit and save. The change reaches Buffer within a few
  minutes. Changes made less than 5 minutes before the publish time can't be
  applied.
- **To stop it**, set the status to **Canceled** (or back to **Draft**) and save.
  It is removed from Buffer.
- Please don't edit or delete these posts directly in Buffer. The editor is the
  source of truth, and its next save will overwrite Buffer.

## Feast-day drafts

Every Monday, drafts are created for Sundays and great feasts in the coming
three months, with a suggested caption. The **Team notes** list the feast, the
saints of the day and the readings, with a link to the full calendar entry.

For each one:

1. Check the caption for accuracy and tone. Edit freely.
2. Add an icon of the feast or saint (please use images we are allowed to use).
3. Set the status to **Ready for review** or **Approved**.

If you don't want to post about a day, set it to **Canceled**. It won't be
recreated.

## Archived posts

Published and canceled posts leave the editor on the next automation run.
Unused calendar drafts also leave once their publish time has passed. They
are preserved in GitHub under `archive/posts/`, along with their Buffer
history; files and uploaded images are not deleted. Archived calendar dates
will not be drafted again.

Manual drafts and posts that are Ready for review, Approved or Scheduled
remain in the editor regardless of age. If canceling a queued post fails,
it stays visible with an automation message until Buffer removal succeeds.

## When something goes wrong

If a post needs attention, the **Automation messages** box at the bottom of the
post explains why, for example:

- *"Instagram posts need at least one image"*: add an image, or untick Instagram.
- *"The publish time has already passed"*: pick a later time.
- *"Images are not reachable yet"*: usually fixes itself within a few minutes.

Use the **Has a problem** filter to find these posts. If something still looks
wrong, contact whoever manages the parish GitHub account.
