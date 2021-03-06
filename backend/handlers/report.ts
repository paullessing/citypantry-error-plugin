import { getReportFromBody, Report, toHumanString } from '@models';
import { APIGatewayProxyHandler, APIGatewayProxyResult } from 'aws-lambda';
import * as uuid from 'uuid/v4';
import { config } from '../../config';
import { awsApi } from '../api/aws.api';
import { Bug, Document as Doc, jiraApi } from '../api/jira.api';
import { slackApi } from '../api/slack.api';
import { createSlackBody } from '../services/slack-body';

export const main: APIGatewayProxyHandler = async (event) => {
  const body = getReportFromBody(event.body);

  const response = await report(body);
  if (response) {
    if (!response.headers) {
      response.headers = {};
    }
    response.headers['Access-Control-Allow-Origin'] = '*';
  }
  return response as APIGatewayProxyResult;
}

export const report = async (requestBody: Report): Promise<APIGatewayProxyResult> => {
  const parsedReport = requestBody as Report & { impact: string };
  const report = {
    ...parsedReport,
    name: trim(parsedReport.name),
    summary: trim(parsedReport.impact || parsedReport.summary),
    description: trim(parsedReport.description),
    affectedPeople: trim(parsedReport.affectedPeople),
    stepsToReproduce: trim(parsedReport.stepsToReproduce),
    currentUser: trim(parsedReport.currentUser)
  } as Report;

  // SLACK
  const screenshot = report.screenshot ? Buffer.from(report.screenshot.replace(/^data:image\/\w+;base64,/, ''), 'base64') : null;

  const reportUuid = uuid(); // used in filenames so that they are not guessable by the public
  const imageName = `screenshot-${report.name.replace(/\W/gi, '').toLowerCase()}-${report.time}-${reportUuid}.png`;
  const errorFileName = `console-errors-${report.name.replace(/\W/gi, '').toLowerCase()}-${report.time}-${reportUuid}.json`;
  let dataUrl: string | null = null;
  if (report.consoleErrors && report.consoleErrors.length > 1000) {
    console.log(`consoleErrors is too long (${report.consoleErrors.length}, uploading`);
    dataUrl = await awsApi.uploadText(report.consoleErrors, errorFileName);
    console.log(`Uploaded consoleErrors to ${dataUrl}`);
  }
  const slackId = await getSlackId(report.email);

  const imageUrl = screenshot ?
    await awsApi.uploadImage(screenshot, imageName) :
    null;
  if (imageUrl) {
    console.log(`Uploaded image to ${imageUrl}`);
  }

  // JIRA
  const bug: Bug = {
    incidentSize: report.incidentSize,
    summary: report.summary,
    description: createJiraDescription(report, imageUrl, dataUrl)
  };

  try {
    const issueKey = await jiraApi.createIssue(bug);

    const { post: slackPost, threadReply } = createSlackBody(report, slackId, issueKey);
    console.log('Posting', slackPost);
    const channel = report.isTest ? '#slack-test' : config.channel;
    const { permalink: slackUrl, ts: slackTs, channel: slackChannel } = await slackApi.post({ ...slackPost, channel });
    await slackApi.post({ // Thread reply
      channel: slackChannel,
      threadTs: slackTs,
      blocks: threadReply
    });
    if (screenshot) {
      try {
        await slackApi.uploadImage({
          data: screenshot,
          channels: slackChannel,
          threadTs: slackTs,
          filename: 'Screenshot for ' + issueKey
        });
      } catch (e) {
        console.log('Error uploading screenshot', e);
        await slackApi.post({
          channel: slackChannel,
          threadTs: slackTs,
          text: '*Screenshot:* ' + imageUrl
        })
      }
    }

    if (slackUrl) {
      await jiraApi.updateIssueDescription(issueKey, updateDescriptionWithSlackLink(bug, slackUrl));
      await jiraApi.updateBugMetadata(issueKey, {
        slackReport: {
          permalink: slackUrl,
          channel: slackChannel,
          ts: slackTs,
        }
      });
    }
  } catch (error) {
    console.log('Upstream error', error);
    return {
      statusCode: 503,
      body: JSON.stringify(error),
    }
  }

  return {
    statusCode: 200,
    body: '"Invoked successfully!"',
  };
}

async function getSlackId(email: string): Promise<string | null> {
  let slackId = null;
  try {
    const user = await slackApi.findUserByEmail(email);
    if (user) {
      slackId = user.id;
    }
  } catch (e) {
    console.log('Failed to retrieve Slack user:', e);
  }
  return slackId;
}

function trim(text: string): string {
  return (text || '').trim();
}


function createJiraDescription(report: Report, screenshotUrl: string | null, dataUrl: string | null): Bug['description'] {
  return {
    version: 1,
    type: 'doc',
    content: [
      Doc.p(Doc.text(report.description)),
      Doc.p(
        Doc.text('User: ', 'strong'), Doc.text((report.isMasquerading ? 'Masquerading as ' : '') + report.currentUser), Doc.br,
        Doc.text('URL: ', 'strong'), Doc.link(report.url), Doc.br,
        Doc.text('Time: ', 'strong'), Doc.text(report.time),
      ),
      Doc.p(
        Doc.text('Steps to Reproduce:', 'strong'), Doc.br,
        Doc.text(report.stepsToReproduce)
      ),
      Doc.p(
        Doc.text('Dev notes:', 'strong'), Doc.br, Doc.text('Insert details here', 'em'),
      ),
      Doc.p(Doc.text('Affected People: ', 'strong'), Doc.text(report.affectedPeople)),
      Doc.p(Doc.text('Number of Affected People: ', 'strong'), Doc.text(toHumanString(report.incidentSize))),
      Doc.p(Doc.text('Screenshot:', 'strong'), Doc.br, screenshotUrl ? Doc.link(screenshotUrl) : Doc.text('No Screenshot')),
      Doc.p(Doc.text('Console data:', 'strong'), Doc.br,
        dataUrl ?
          Doc.link(dataUrl) :
          (report.consoleErrors ?
            Doc.text('base64: ' + Buffer.from(report.consoleErrors).toString('base64')) :
            '<no data>'
          )),
      Doc.p(Doc.text('Reported By: ', 'strong'), Doc.text(report.name)),
    ]
  };
}

function updateDescriptionWithSlackLink(bug: Bug, slackUrl: string): Bug['description']['content'] {
  return [
    ...bug.description.content,
    Doc.p(Doc.text('Slack Link: ', 'strong'), Doc.link(slackUrl)),
  ];
}
