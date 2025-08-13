# Remote Follow
A basic ActivityPub remote follow page.

The idea is, you can add follow buttons to your own website with URLs in the
form of `https://remotefollow.onrender.com/<IdOrHandle>`, allowing others to
follow you on their own servers.

## Usage
Go to `https://remotefollow.onrender.com/<IdOrHandle>`  
where `<IdOrHandle>` is a valid ActivityPub actor URI, or a mastodon style
handle.

The actor and webfinger information will be fetched, and their avatar, name,
handle and id will be displayed, along with their description (if they have
one).

You will also be prompted to enter your own handle or id. Upon doing so, your
own details will be fetched (and stored in a cookie), and if your webfinger has
a `http://ostatus.org/schema/1.0/subscribe` link, a follow button will show up
directing you to your server's follow page. If not, a message will display with
the id and handle ready to copy and paste into your server's search.

