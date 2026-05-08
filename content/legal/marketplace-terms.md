---
title: Marketplace Terms of Use
lastUpdated: 2026-05-08
seo: noindex
---

# Marketplace Terms of Use

**Last Updated:** May 8, 2026

These Marketplace Terms of Use govern your access to and use of the WorldWideView Marketplace (marketplace.worldwideview.dev) to discover, download, and install plugins.

## 1. Description of the Marketplace
The Marketplace allows you to discover software plugins developed by independent third-party developers that extend the functionality of the WorldWideView application.

## 2. Third-Party Content Disclaimer
**USE AT YOUR OWN RISK.** 
The vast majority of plugins on the Marketplace are created by independent developers, not by WorldWideView. We do not independently verify the code, security, or data accuracy of every plugin. 
- **Unverified Plugins**: When you install an unverified plugin, the platform will display a warning dialog. You must acknowledge that the plugin runs locally in your browser context and may have access to the globe rendering pipeline and external network requests.
- **Liability**: WorldWideView assumes no responsibility or liability for any damages, data loss, or system instability caused by third-party plugins.

## 3. Installation and Authentication
To install plugins directly into your WorldWideView instance, the Marketplace generates a short-lived, scoped JWT token (`issueMarketplaceToken()`) to authenticate the bridge between the Marketplace and your local/cloud application. You must be authenticated to use this feature. You may not attempt to reverse engineer or abuse this bridge mechanism.

## 4. Plugin Data and Privacy
Plugins may register data sources that fetch from external third-party APIs. By installing a plugin, you agree that the plugin may transmit network requests from your browser to those third-party services. Please review the documentation provided by the plugin author to understand what data is accessed.

## 5. Payments and Refunds
For paid plugins:
- Your transaction is processed securely via Stripe.
- Due to the digital nature of downloadable software, all sales of plugins are final. Refunds are only granted at our discretion if a plugin is fundamentally broken, maliciously misrepresented, or violates our Developer Distribution Agreement.
- Contact support within 7 days of purchase if you believe you are entitled to a refund.

## 6. Reporting Abuse
If you discover a plugin that contains malware, steals data, violates intellectual property, or is otherwise abusive, please report it immediately to legal@worldwideview.dev. We reserve the right to remotely disable or uninstall malicious plugins from your instance to protect your security.

## 7. Governing Law
These Terms are governed by the laws of New Zealand.

## 8. Contact
legal@worldwideview.dev
Silver Phung trading as WorldWideView, 93A Forrest Hill Rd, Milford, Auckland, New Zealand.
