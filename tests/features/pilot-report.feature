@feature_id:8810a366-70b1-4b42-a9ca-ab8411e7ce9c @epic_id:7fa09393-08c8-499d-801e-d4aad6a80ab9
Feature: F4.2 Pilot report
  A project's pilot report shows hours logged against the firm's own baseline (whole project
  and drafted sections, with the PRD's proposed targets) and how much of each draft came back
  from Word unchanged; it downloads as PDF and as CSV, and the firm's RA lead signs it.
  Exact figures (20 h against an 88 h baseline: 77% and 53% lower; acceptance from a
  re-imported draft), the PDF and the CSV are proved by tests/api_definitions/pilot/* with
  fixtures 43_pilot_report.py and 41_firm_style.py; the runner cannot open downloads.
  Source: client/src/pages/app/ProjectPilotReportPage.tsx

  Background:
    Given I navigate to "/signup"
    When I fill "fullName" with "Ana Pilot"
    And I fill "email" with "${random_email}"
    And I fill "password" with "${default:password}"
    And I fill "firmName" with "${random_name}"
    And I click "Create workspace"
    And I click "Clients and projects"
    And I fill "clientName" with "Northbay Devices"
    And I click "Add client"
    And I fill "deviceName" with "IS-200 infusion set"
    And I click "Add device"
    And I fill "projectName" with "IS-200 Traditional 510(k)"
    And I click "Start submission"
    And I click "IS-200 Traditional 510(k)"
    And I click "Pilot report"

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:c85951a3-6c83-4e15-98b2-3c013d6244e9
  Scenario: The firm enters its baseline and its RA lead signs the pilot report
    Then I should see "Time your firm logged on this project against its own baseline"
    And I should see "Drafts kept without change"
    And I should see "No draft re-imported from Word yet."
    And I should see "Download PDF"
    And I should see "Firm baseline"
    When I fill "baselineBasis" with "Traditional 510(k), infusion set, 2025"
    And I fill "baseline-write" with "16"
    And I fill "baseline-tabulate" with "8"
    And I fill "baseline-reconcile" with "6"
    And I click "Save baseline"
    Then I should see "Baseline saved."
    And I should see "Firm baseline · 30.0 h"
    When I fill "signerTitle" with "RA lead"
    And I fill "signoffNote" with "Checked against our timesheets"
    And I click "Sign the report"
    Then I should see "Report signed."
    And I should see "Signed by Ana Pilot, RA lead"
