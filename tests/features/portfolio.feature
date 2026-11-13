@feature_id:a9989cf7-a469-42a2-81d9-13fef57ed378 @epic_id:f514455d-a411-4454-80bd-7993a8652afd
Feature: F5.3 Portfolio overview
  A consultant sees every submission in the firm at a glance: totals for active projects, open
  client requests, open high problems and running FDA clocks, and for each project its stage,
  next action, due date and risks, soonest due first.
  The totals, ordering, FDA-letter due dates, client requests and paging are proved by
  tests/api_definitions/portfolio/portfolio-get.json with fixture 50_portfolio.py.
  Portfolio is a phase 4 menu item; dev turns it on early with FEATURE_FLAGS_ON=portfolio.
  Source: client/src/pages/app/PortfolioPage.tsx

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:6ca66d46-8f68-4bdf-aee6-ea5e1ed5075a
  Scenario: A new project appears on the portfolio with its stage, due date and risks
    Given I navigate to "/signup"
    When I fill "fullName" with "Ana Lindqvist"
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
    And I fill "targetDate" with "2026-01-15"
    And I click "Start submission"
    And I click "Portfolio"
    Then I should see "active 510(k) project"
    And I should see "open client requests"
    And I should see "FDA clocks running"
    And I should see "1 project is past due."
    And I should see "IS-200 Traditional 510(k)"
    And I should see "Drafting"
    And I should see "Run the problem check"
    And I should see "days overdue"
    And I should see "High risk"
    When I click "Show cleared"
    Then I should see "No projects here yet."
