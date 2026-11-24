# tampermonkey-scripts

A collection of Tampermonkey userscripts for automating everyday browser tasks and customizing websites.

## Install with Tampermonkey

1. Install the [Tampermonkey browser extension](https://www.tampermonkey.net/).
2. Open the `.user.js` file you want on GitHub and click **Raw**.
3. Click **Install** in Tampermonkey. The script will appear under **Dashboard → Installed userscripts**. [Installation help](https://www.tampermonkey.net/faq.php?locale=en&q=Q102)

## Private configuration

Use these steps for scripts that support custom site addresses and settings. Replace the example domains and selector with your own values.

1. In **Dashboard → Settings**, set **Config mode** to **Advanced** and save.
2. In **Installed userscripts**, click the script name. Open **Settings → User matches**, add each URL pattern as a separate entry, and save. These patterns control where the script runs. [URL matching help](https://www.tampermonkey.net/faq.php?locale=en&q=Q103)

   ```text
   https://start.example/*
   https://work.example/*
   ```

3. In the same editor, open **Storage**. Add the settings your script supports to the existing JSON and keep any other entries. If **Storage** is missing, run the script on a matching page and reopen the editor after the script has saved its initial data. [Editing script storage](https://www.tampermonkey.net/faq.php?locale=en&q=Q400)

   A timer that supports `timerConfig` can use this example.

   ```json
   {
     "timerConfig": {
       "startupOrigin": "https://start.example",
       "workOrigin": "https://work.example",
       "readySelector": "#ready-marker"
     }
   }
   ```

   `startupOrigin` is the entry page’s origin, `workOrigin` is the destination page’s origin, and `readySelector` is the CSS selector for the element that starts the timer when it appears. Enter origins in **Storage** without the trailing `/*`.

4. Save **Storage** and refresh the page. Keep your real addresses and selectors in Tampermonkey’s local configuration.

For help with private configuration, contact the maintainer directly.

## Updates

Tampermonkey checks `@updateURL` for releases with a higher `@version`. Set up your private configuration once per browser profile. [Update documentation](https://www.tampermonkey.net/documentation.php?locale=en&q=update_url)
