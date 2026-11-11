@feature_id:9f681fa2-274c-4df2-a91f-d57dee368de1 @epic_id:9d350589-13a9-4573-8e7a-600d3ec59a32
Feature: F2.4 Client requests and no-login upload
  A consultant drafts a request for missing evidence, edits it and approves it; nothing
  reaches the client before approval. Approval creates an expiring upload link (shown
  once). The client opens it on a phone without an account and uploads files, which join
  the submission's files and mark the item received. A link can be withdrawn.
  Source: client/src/pages/app/ProjectRequestsPage.tsx, client/src/pages/ClientUploadPage.tsx

  Background:
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
    And I click "Client requests"
    And I fill "requestTitle" with "Missing evidence for DC-100"
    And I fill "requestMessage" with "Please upload the documents below."
    And I fill "itemLabel1" with "Hub drawing"
    And I click "Save draft"
    Then I should see "Draft, not sent"

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:2266ea0f-b976-4af4-aadd-8a77d2de3e94
  Scenario: The client uploads a requested file from the link without an account
    When I click "Approve and create link"
    Then I should see "Upload link ready"
    And I should see "Approved, waiting for files"
    When I click "Open the upload page"
    Then I should see "Secure upload"
    And I should see "Missing evidence for DC-100"
    And I should see "Requested"
    When I upload "tests/fixtures/ingest/hub-drawing.pdf" to "file-1"
    Then I should see "Received hub-drawing.pdf. Thank you."
    And I should see "Add another file"

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:d18f897c-02a0-4549-b0db-df7788709d3b
  Scenario: A consultant withdraws a link so it can no longer be used
    When I click "Approve and create link"
    Then I should see "Upload link ready"
    When I click "Withdraw link"
    Then I should see "Link withdrawn. The client can no longer upload with it."
    And I should see "Upload link: withdrawn"

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:c8cb946f-af2c-4d80-871c-3902f35c6bc2
  Scenario: The tool drafts the client message and the consultant edits and saves it before approval
    When I click "Draft the message with AI"
    Then I should see "Message drafted by"
    And I should see "Nothing is sent until you approve."
    When I fill "draftMessage" with "Hello Ana, please upload the hub drawing for the DC-100 submission. Thank you."
    And I click "Save draft"
    Then I should see "Draft saved."
    And I should see "Draft, not sent"
