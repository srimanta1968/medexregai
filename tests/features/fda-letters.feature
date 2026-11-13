@feature_id:af7a916c-8bab-433f-9dab-3ae83f278b73 @epic_id:f514455d-a411-4454-80bd-7993a8652afd
Feature: F5.1 FDA letter tracker
  A consultant pastes (or picks the forwarded file of) an FDA Additional Information letter,
  checks the numbered deficiencies it is split into, saves it with the 180-day deadline clock
  (FDA: a complete response within 180 calendar days of the letter date, no extensions),
  tracks each deficiency's owner and status, and exports a Word response skeleton.
  The letter text is FICTIONAL and marked as not from FDA. Splitting a forwarded letter file,
  links to client files and the DOCX contents are proved by tests/api_definitions/fda-letters/*
  with fixture 46_fda_letters.py; the runner cannot open a downloaded file. A deficiency's
  status change is proved by fda-deficiency-patch.json (the runner does not read the confirmation).
  FDA letters is a phase 4 menu item; dev turns it on early with FEATURE_FLAGS_ON=fda-letters.
  Source: client/src/pages/app/ProjectFdaLettersPage.tsx

  Background:
    Given I navigate to "/signup"
    When I fill "fullName" with "Ana Letters"
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
    And I click "FDA letters"

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:8eb5a4c3-2071-4a7a-9bc7-457bd7b6236d
  Scenario: A pasted AI letter is split, confirmed and tracked against its deadline
    Then I should see "No FDA letters logged for this project."
    When I fill "letterText" with "FICTIONAL TEST LETTER - NOT FROM FDA. June 2, 2026. Re: K269999. We need the following: 1. Please provide ECH residual results for the EO sterilized device per ISO 10993-7. 2. Please provide the full cytotoxicity report referenced in your biocompatibility summary. If you have any questions about this letter, please contact the lead reviewer."
    And I click "Split into deficiencies"
    Then I should see "Check the split against the letter."
    And I should see "2 deficiencies to save · response due 2026-11-29"
    And I should see "Section suggested from:"
    When I click "Save letter"
    Then I should see "Letter saved with 2 deficiencies. Response due 2026-11-29."
    And I should see "Additional Information request · K269999 · letter of 2026-06-02"
    And I should see "Please provide ECH residual results for the EO sterilized device per ISO 10993-7."
    And I should see "Sterility"
    When I click "Export response skeleton (Word)"
    Then I should see "Response skeleton downloaded."
    When I click "Mark responded"
    Then I should see "Marked as responded."
    And I should see "Reopen"
    When I select "drafting" from "status-1"

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:4af8cd48-bed9-4dbe-8476-a75ffa49356e
  Scenario: A split can be corrected before it is saved
    When I fill "letterText" with "FICTIONAL TEST LETTER - NOT FROM FDA. June 2, 2026. 1. Please clarify the shelf-life claim. 2. Please update the labeling for MR safety."
    And I click "Split into deficiencies"
    Then I should see "2 deficiencies to save"
    When I click "Leave out deficiency 2"
    Then I should see "1 deficiencies to save"
    When I click "Discard split"
    Then I should see "Split into deficiencies"
    And I should see "No FDA letters logged for this project."
