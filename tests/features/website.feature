@feature_id:37cc3f14-4a07-459d-bfb6-a9e02bb2c9a2 @epic_id:5f48b2cc-2827-4919-a54f-d5d55400a2bb
Feature: F0.5 Public marketing website
  A visitor learns what MedexRegAI does and moves between the public pages
  through the shared header and footer.
  Source: client/src/App.tsx, client/src/components/site/SiteLayout.tsx, client/src/pages/*Page.tsx

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:7c58bc32-6024-4a4e-9710-61d023ef32e7
  Scenario: Visitor sees the product promise on the homepage
    Given I navigate to "/"
    Then I should see "Turn client files into eSTAR-ready 510(k) sections"
    And I should see "Now enrolling consultancies for the pilot programme"
    And I should see "Illustrative concept screen. Client, files and values are fictional."
    And I should see "What never changes"

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:bc0a5c66-abc6-46b1-a0d4-f358bc36e6c2
  Scenario: Visitor opens the product page from the header
    Given I navigate to "/"
    When I click "Product"
    Then I should see "From client folder to reviewed Word draft"
    And I should see "Gaps and contradictions"

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:ec0da27b-8f7e-4681-9833-85f8957641fc
  Scenario: Visitor reads how the workflow runs and who does what
    Given I navigate to "/how-it-works"
    Then I should see "Five steps, and you decide at every one"
    And I should see "Who does what"
    And I should see "Fills, signs and files the eSTAR"

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:12437faf-2674-45da-8174-2ad9369b2a35
  Scenario: Quality or IT owner reads how client data is handled
    Given I navigate to "/security"
    Then I should see "Client files are confidential. We built around that."
    And I should see "How client data is handled, by design"
    And I should see "Your trust pack"

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:c6335814-cf70-4a07-8fb1-9aa5b6f9a135
  Scenario: Visitor reads how the pilot programme runs
    Given I navigate to "/pilot"
    Then I should see "Measure it on your own 510(k)s"
    And I should see "What each side brings"
    And I should see "Pilot terms are agreed with each firm."

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:5e7a0bab-601c-4eda-8b5c-05196118627e
  Scenario: Visitor opens an FAQ answer
    Given I navigate to "/faq"
    Then I should see "Questions consultants ask us"
    When I click "Does MedexRegAI file submissions with FDA?"
    Then I should see "MedexRegAI never files with FDA and never signs anything."

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:807be688-1644-43a3-b3bb-860b3a44314c
  Scenario: Visitor reads about the company
    Given I navigate to "/about"
    Then I should see "Shaped by 510(k) consultants, around their real work"
    And I should see "Our principles"

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:205aff8c-445a-48b4-9ebb-0eedaab7272a
  Scenario: Visitor uses the call to action to reach the pilot page
    Given I navigate to "/security"
    When I click "Request a pilot"
    Then I should see "Measure it on your own 510(k)s"

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:e3bbf9ac-8e40-47ac-9197-2e9ab5c88450
  Scenario: Unknown pages show a not-found screen with a way home
    Given I navigate to "/this-page-does-not-exist"
    Then I should see "Page not found"
    When I click "Back to home"
    Then I should see "Turn client files into eSTAR-ready 510(k) sections"

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:5d16c89c-c41b-4b42-b549-2c2cc4ace040
  Scenario: Visitor requests a pilot and sees a confirmation
    Given I navigate to "/pilot"
    When I fill "name" with "${random_name}"
    And I fill "workEmail" with "${random_email}"
    And I fill "firmName" with "${random_name}"
    And I fill "role" with "RA lead"
    And I fill "message" with "Two 510(k)s are coming up this quarter and we would like to try the pilot."
    And I click "Send pilot request"
    Then I should see "Thank you, your pilot request has been received."

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:6e82f592-dba0-40e7-a01b-5fa011fec2a3
  Scenario: Pilot request form explains what is missing
    Given I navigate to "/contact"
    When I fill "workEmail" with "not-an-email"
    And I click "Send pilot request"
    Then I should see "Please enter your name."
    And I should see "Please enter a valid email address."
    And I should see "Please tell us a little more (at least 10 characters)."
