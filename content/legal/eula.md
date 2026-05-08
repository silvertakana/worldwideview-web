---
title: End User License Agreement
lastUpdated: 2026-05-08
seo: noindex
---

# End User License Agreement (EULA)

**Last Updated:** May 8, 2026

This End User License Agreement ("Agreement") is a legal agreement between you and Silver Takana trading as WorldWideView ("we," "us," or "our") governing your use of the WorldWideView Local/Self-Hosted Edition software ("Software").

By downloading, installing, or using the Software, you agree to be bound by the terms of this Agreement. If you do not agree to these terms, do not install or use the Software.

## 1. License Grant
Subject to your compliance with this Agreement, we grant you a limited, non-exclusive, non-transferable, revocable license to install and use the Software on your own infrastructure for personal, internal business, or educational purposes. You are licensing the Software, not purchasing it. Access to the source code does not constitute a transfer of ownership.

## 2. Restrictions
You agree NOT to:
- Reverse engineer, decompile, or disassemble the proprietary private data engine (`wwv-data-engine-internal`).
- Remove, alter, or obscure any copyright, trademark, or other proprietary notices from the Software.
- Redistribute, sell, or rent the compiled Software application as a standalone product.
- Bypass or modify the marketplace authentication bridge (`WWV_BRIDGE_TOKEN`) to circumvent intended access controls.
- Use the Software to create a directly competing commercial platform.

## 3. Open Source Components and Architecture
WorldWideView utilizes a hybrid architecture:
- **Public Data Engine**: The `wwv-data-engine` repository is open-source under the MIT License. It is a completely separate project from the core Software.
- **Private Data Engine**: The `wwv-data-engine-internal` is proprietary and is never distributed to users. 
- **Plugin SDK**: The `@worldwideview/wwv-plugin-sdk` is separately licensed for the purpose of community plugin development.
Third-party libraries and dependencies included in the Software are subject to their respective open-source licenses.

## 4. User-Provided API Keys
The Software requires certain external data sources (e.g., Google Maps, NASA FIRMS) to function optimally. You must provide your own API keys for these services.
- API keys are stored in your browser's local storage.
- The Software communicates directly with these third-party APIs from your browser.
- We do not transmit your API keys to our servers.
- **You are solely responsible for all usage costs, quotas, and compliance associated with your API keys.**

## 5. Telemetry and Analytics
The Software is configured to collect anonymous telemetry data (via Umami) and error reports (via GlitchTip) to help us improve stability and performance. 
- You maintain control over your environment and may block these outbound telemetry requests using browser Content Security Policies (CSP), ad-blockers, or firewall rules without affecting the core functionality of the Software.

## 6. Data Ownership
You retain full ownership of all data stored within your local SQLite database, as well as any custom GeoJSON files or configurations you create or import.

## 7. Updates
We may provide updates to the Software via Docker image registries. We are under no obligation to provide continuous updates, but we strongly recommend applying security patches when released. Breaking changes will be documented in our release notes.

## 8. Disclaimer of Warranties
THE SOFTWARE IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED, INCLUDING, BUT NOT LIMITED TO, IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT. WE DO NOT WARRANT THAT THE SOFTWARE WILL OPERATE UNINTERRUPTED OR ERROR-FREE, OR THAT IT WILL MEET YOUR SPECIFIC REQUIREMENTS.

## 9. Data Accuracy Disclaimer (Important)
The Software is designed to visualize geospatial data from third-party and community sources. We make no representations regarding the accuracy, timeliness, or safety of this data. **You must not use the Software for active aviation/maritime navigation, military operations, emergency response, or life-safety decisions.**

## 10. Limitation of Liability
IN NO EVENT SHALL WORLDWIDEVIEW BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, OR CONSEQUENTIAL DAMAGES (INCLUDING DATA LOSS, HARDWARE FAILURE, OR INFRASTRUCTURE COSTS) ARISING OUT OF THE USE OR INABILITY TO USE THE SOFTWARE, EVEN IF WE HAVE BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.

## 11. Termination
This license is effective until terminated. Your rights under this Agreement will terminate automatically without notice if you fail to comply with any of its terms. Upon termination, you must cease all use of the Software and destroy all copies in your possession.

## 12. Governing Law
This Agreement shall be governed by the laws of New Zealand. Any disputes arising under this Agreement shall be subject to the exclusive jurisdiction of the courts of New Zealand.

## 13. Contact
For legal inquiries regarding this Agreement, contact:
legal@worldwideview.dev
Silver Takana trading as WorldWideView, 93A Forrest Hill Rd, Milford, Auckland, New Zealand.
