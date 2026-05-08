---
title: Acceptable Use Policy
lastUpdated: 2026-05-08
seo: noindex
---

# Acceptable Use Policy (AUP)

**Last Updated:** May 8, 2026

This Acceptable Use Policy applies to your use of the WorldWideView Cloud Platform and Demo instances. It is incorporated by reference into our Cloud Terms of Service.

## 1. Prohibited Activities
You may not use WorldWideView to engage in, foster, or promote illegal, abusive, or irresponsible behavior, including:

- **Data Scraping & Exfiltration**: Attempting to reverse-engineer, scrape, or programmatically intercept the WebSocket streams from the `wwv-data-engine` for external use or redistribution.
- **Harmful Payloads**: Uploading malicious GeoJSON files, massive un-chunked datasets, or malformed configurations designed to crash, degrade, or overload the WorldWideView rendering pipeline.
- **System Abuse**: Attempting to bypass the platform's rate limits (`rateLimit.ts`) intentionally, or launching Denial of Service (DoS) attacks against our infrastructure.
- **Account Sharing**: Sharing your single-seat Pro or Basic credentials with multiple users to bypass seat-based pricing.
- **Demo Abuse**: Utilizing the public Demo edition for persistent production workloads or commercial presentations without authorization.

## 2. Real-World Use Restrictions
Given the nature of the data visualized (aviation, maritime, conflict events), you strictly agree **NOT** to use WorldWideView for:
- Active military targeting, surveillance, or tactical operations.
- Directing or managing air traffic, or making aviation navigation decisions.
- Directing or managing maritime vessels.
- Emergency response, disaster management, or any life-safety critical operations.

*WorldWideView is a visualization tool, not a certified navigation or radar system.*

## 3. Data Source Restrictions & Compliance
Many plugins connect to third-party data providers. You must respect the terms of the underlying data providers:
- **OpenSky Network**: OpenSky data is subject to their own non-transferable license. You may not extract or redistribute OpenSky data obtained through WorldWideView.
- **AIS Stream**: Maritime data is subject to the terms of the source provider.
- Redistribution of aggregated data feeds provided by the Cloud Platform is strictly prohibited.

## 4. Enforcement and Rate Limits
We enforce systemic rate limits to protect platform stability:
- **Marketplace API**: Install requests (10 req/min), Token generation (5 req/min), General status (30 req/min).
- **Data Engine**: WebSocket concurrent connection limits and message throughput limits.

Violations of this Acceptable Use Policy may result in a warning, temporary suspension, or permanent termination of your account without a refund. We reserve the right to report illegal activity to appropriate law enforcement authorities.

## 5. Reporting Abuse
To report a violation of this policy, please contact legal@worldwideview.dev.
