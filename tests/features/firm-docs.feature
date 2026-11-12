@feature_id:80537ab9-7bf2-419f-b19d-0e8f8e76968b @epic_id:5d0b3c77-a0ba-4b5e-b4db-f1b36462d071
Feature: F3.6 Templates and admin docs (board and draft screen)
  The review board drafts the summary of testing (with its mismatch count) and the 510(k)
  Summary, cover letter, FDA 3601 preparation sheet and Truthful and Accurate statement
  from project data, with every signature field left blank; a section's draft screen shows
  the firm's style and flags claims beyond the Indications for Use or the evidence.
  The runner has no file-upload step, so a project here has no test report or ready draft:
  a summary table with a mismatch, the documents' content and claim warnings on an edit are
  proved by tests/api_definitions/submission-docs/* and drafts/section-draft-get.json with
  fixture 41_firm_style.py.
  Source: client/src/pages/app/ProjectReviewPage.tsx, client/src/pages/app/SectionDraftPage.tsx

  Background:
    Given I navigate to "/signup"
    When I fill "fullName" with "Ana Documents"
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
    And I click "Review"

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:f1268315-2eee-4fbb-9f1b-81a74cfa669b
  Scenario: The review board drafts the summary of testing and the administrative documents
    Then I should see "Documents drafted from the project"
    And I should see "Summary of testing"
    And I should see "0 test reports · 0 mismatches with the drafts"
    And I should see "510(k) Summary"
    And I should see "Cover letter"
    And I should see "FDA 3601 preparation sheet"
    And I should see "Form FDA 3601 itself is created in FDA's online user fee system"
    And I should see "Truthful and Accurate statement"
    And I should see "Nothing to complete · signature fields left blank"
    And I should see "FDA: signed by a responsible person of the submitting firm, not a consultant."

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:12a79f46-ad50-4385-86a7-e236f85fb841
  Scenario: A section's draft screen shows the firm's style and the claim check
    When I click "Device description"
    And I click "Open draft"
    Then I should see "No draft yet"
    And I should see "Claims beyond the Indications for Use or the cited evidence are flagged for you to decide."
    And I should see "Firm style for this section"
    And I should see "Firm style sources are off, so drafts use no template or past wording."
