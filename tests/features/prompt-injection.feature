@feature_id:0c5e7968-0d64-41dc-bb62-74204eef3a96 @epic_id:a2a13814-9ec9-4434-93d1-8a294f718a41
Feature: F7.5 Prompt-injection defence
  Client files are untrusted input. Text in them that reads like instructions to an AI
  is shown to the consultant and treated as document content only; no AI step can use
  tools, and every answer is checked against the step's format and the passages it was
  given. The planted-instruction fixture is tests/fixtures/injection/injected-report.docx
  (a hidden run and a white 1-pt run in its results paragraph); docproc must be running
  to read it. The full injection test set runs in CI (npm run test:injection).
  Source: client/src/pages/app/ProjectFilesPage.tsx, client/src/pages/app/AiSettingsPage.tsx

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:f850f92f-9367-4490-b915-750d393cb001
  Scenario: Instructions hidden in a client file are flagged and treated as document content
    Given I navigate to "/signup"
    When I fill "fullName" with "${random_name}"
    And I fill "email" with "${random_email}"
    And I fill "password" with "${default:password}"
    And I fill "firmName" with "${random_name}"
    And I click "Create workspace"
    And I click "Clients and projects"
    And I fill "clientName" with "Northbay Devices"
    And I click "Add client"
    And I fill "deviceName" with "DC-100 catheter"
    And I click "Add device"
    And I fill "projectName" with "DC-100 Traditional 510(k)"
    And I click "Start submission"
    And I click "DC-100 Traditional 510(k)"
    And I click "Files"
    And I upload "tests/fixtures/injection/injected-report.docx" to "files"
    Then I should see "No patient data found"
    When I click "Versions"
    Then I should see "Text in this file reads like instructions to an AI (2 places)"
    And I should see "MedexRegAI treats it as document content only and never follows it"
    And I should see "Asks to ignore instructions at 5 Results"
    And I should see "Addressed to an AI at 5 Results"

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:465e12f7-9f23-4efe-956e-c2a9aa81f9b9
  Scenario: Owner sees that no AI step can use tools and every answer is checked
    Given I navigate to "/signup"
    When I fill "fullName" with "${random_name}"
    And I fill "email" with "${random_email}"
    And I fill "password" with "${default:password}"
    And I fill "firmName" with "${random_name}"
    And I click "Create workspace"
    And I click "AI models and cost"
    Then I should see "Client files cannot instruct the AI"
    And I should see "No step can use tools"
    And I should see "Tools: none · Checked: classify JSON {section from the allowed list, confidence, reason, cites}"
    And I should see "Tools: none · Checked: prose with [B#] citations to given passages, no links or images"
    And I should see "Last 30 days: 0 answers checked, 0 discarded."
