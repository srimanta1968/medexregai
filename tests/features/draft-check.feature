@feature_id:9d6b89e3-d4e0-4774-baa3-594e89aaa63a @epic_id:5d0b3c77-a0ba-4b5e-b4db-f1b36462d071
Feature: F3.5 Draft check
  Every predicate K-number in a section draft is checked against FDA data: verified ones
  show inline as "verified with FDA" with their recall and MAUDE flags, and a K-number not
  in FDA's 510(k) data is flagged beside the statement that names it.
  The runner has no file-upload step, so a project here has no ready draft: the check itself
  (a real predicate with recalls and a K-number FDA never issued) is proved by
  tests/api_definitions/drafts/section-draft-fda-check-post.json and section-draft-get.json
  with fixture 40_draft_check.py.
  Source: client/src/pages/app/SectionDraftPage.tsx

  Background:
    Given I navigate to "/signup"
    When I fill "fullName" with "Ana Checker"
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
    And I click "Sterility"
    And I click "Open draft"

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:787c04b8-0093-4289-b002-bf06df674e67
  Scenario: A section without a draft says its predicates will be checked with FDA
    Then I should see "No draft yet"
    And I should see "Any predicate K-number in the draft is then checked against FDA data"
    And I should see "with its recalls and MAUDE reports shown beside it."
