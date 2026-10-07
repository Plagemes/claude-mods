# Security Policy

## Important: Plugin Permissions

Claude Code mods run with the permissions and access of the user who installed them. Mods can access:

- The file system (reading and writing files the user can access)
- Claude Code commands and state
- Any environment variables or secrets available to the user
- Network access based on the user's environment

**This means you should review mods before installing them, just as you would review any software you install.**

## Reporting Vulnerabilities

We take security seriously. If you discover a security vulnerability in this project:

### Report via GitHub Private Vulnerability Reporting

1. Go to the repository's Security tab
2. Click "Report a vulnerability"
3. Provide details about the vulnerability, including:
   - Description of the issue
   - Steps to reproduce (if applicable)
   - Potential impact
   - Suggested fix (if you have one)

GitHub will create a private security advisory that allows coordinated disclosure before public announcement.

### Report via GitHub Issue (Non-sensitive)

For non-sensitive security concerns, you can open a regular GitHub issue. Use the **Bug Report** template and clearly mark it as a security concern.

## What's In Scope

Security vulnerabilities we care about:

- Code injection or execution vulnerabilities in any mod
- Improper handling of user data or files
- Exposure of sensitive information
- Privilege escalation or unauthorized access
- Vulnerabilities in dependencies

## What's Out of Scope

The following are not in scope for security reports:

- Social engineering or phishing
- User misconfiguration of their system
- Features that require explicit user consent (e.g., running arbitrary code)
- Disclosure issues without impact

## Response Timeline

We aim to:

1. Acknowledge receipt of your report within 48 hours
2. Provide an initial assessment within 5 days
3. Coordinate a fix and timeline for disclosure

## Disclosure Policy

We follow responsible disclosure practices:

- We will work with you to develop and verify a fix
- We will publish a security advisory after a patch is released
- We request that you do not publicly disclose the vulnerability until a fix is available
