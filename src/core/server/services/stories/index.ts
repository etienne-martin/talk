import { defaultTo, uniq } from "lodash";
import { DateTime } from "luxon";
import { Db } from "mongodb";

import isNonNullArray from "coral-common/helpers/isNonNullArray";
import { Config } from "coral-server/config";
import { StoryURLInvalidError, UserNotFoundError } from "coral-server/errors";
import { StoryCreatedCoralEvent } from "coral-server/events";
import { CoralEventPublisherBroker } from "coral-server/events/publisher";
import logger from "coral-server/logger";
import {
  mergeCommentActionCounts,
  mergeManyStoryActions,
  removeStoryActions,
} from "coral-server/models/action/comment";
import {
  calculateTotalCommentCount,
  mergeCommentModerationQueueCount,
  mergeCommentStatusCount,
  mergeManyCommentStories,
  removeStoryComments,
} from "coral-server/models/comment";
import { LiveConfiguration } from "coral-server/models/settings";
import {
  addStoryExpert,
  closeStory,
  createStory,
  CreateStoryInput,
  findOrCreateStory,
  FindOrCreateStoryInput,
  findStory,
  FindStoryInput,
  openStory,
  removeStories,
  removeStory,
  removeStoryExpert,
  resolveStoryMode,
  retrieveManyStories,
  retrieveStory,
  retrieveStorySections,
  setStoryMode,
  Story,
  updateStory,
  updateStoryCounts,
  UpdateStoryInput,
  updateStorySettings,
  UpdateStorySettingsInput,
} from "coral-server/models/story";
import {
  ensureFeatureFlag,
  hasFeatureFlag,
  Tenant,
} from "coral-server/models/tenant";
import { retrieveUser } from "coral-server/models/user";
import { ScraperQueue } from "coral-server/queue/tasks/scraper";
import { findSiteByURL } from "coral-server/services/sites";
import { scrape } from "coral-server/services/stories/scraper";

import {
  GQLFEATURE_FLAG,
  GQLSTORY_MODE,
} from "coral-server/graph/schema/__generated__/types";

export type FindStory = FindStoryInput;

export async function find(mongo: Db, tenant: Tenant, input: FindStory) {
  return findStory(mongo, tenant.id, input);
}

export type FindOrCreateStory = FindOrCreateStoryInput;

export async function findOrCreate(
  mongo: Db,
  tenant: Tenant,
  broker: CoralEventPublisherBroker,
  input: FindOrCreateStory,
  scraper: ScraperQueue,
  now = new Date()
) {
  // Validate the mode if passed.
  if (input.mode) {
    validateStoryMode(tenant, input.mode);
  }

  let siteID = null;
  if (input.url) {
    const site = await findSiteByURL(mongo, tenant.id, input.url);
    // If the URL is provided, and the url is not associated with a site, then refuse
    // to create the Asset.
    if (!site) {
      throw new StoryURLInvalidError({
        storyURL: input.url,
        tenantDomain: tenant.domain,
      });
    }
    siteID = site.id;
  }

  const { story, wasUpserted } = await findOrCreateStory(
    mongo,
    tenant.id,
    input,
    siteID,
    now
  );
  if (!story) {
    return null;
  }

  if (wasUpserted) {
    StoryCreatedCoralEvent.publish(broker, {
      storyID: story.id,
      storyURL: story.url,
      siteID: story.siteID,
    }).catch((err) => {
      logger.error({ err }, "could not publish story created event");
    });
  }

  if (tenant.stories.scraping.enabled && !story.metadata && !story.scrapedAt) {
    // If the scraper has not scraped this story, and we have no metadata, we
    // need to scrape it now!
    await scraper.add({
      storyID: story.id,
      storyURL: story.url,
      tenantID: tenant.id,
    });
  }

  return story;
}

export async function remove(
  mongo: Db,
  tenant: Tenant,
  storyID: string,
  includeComments = false
) {
  // Create a logger for this function.
  const log = logger.child(
    {
      storyID,
      includeComments,
    },
    true
  );

  log.debug("starting to remove story");

  // Get the story so we can see if there are associated comments.
  const story = await retrieveStory(mongo, tenant.id, storyID);
  if (!story) {
    // No story was found!
    log.warn("attempted to remove story that wasn't found");
    return null;
  }

  if (includeComments) {
    // Remove the actions associated with the comments we just removed.
    const { deletedCount: removedActions } = await removeStoryActions(
      mongo,
      tenant.id,
      story.id
    );

    log.debug({ removedActions }, "removed actions while deleting story");

    // Remove the comments for the story.
    const { deletedCount: removedComments } = await removeStoryComments(
      mongo,
      tenant.id,
      story.id
    );

    log.debug({ removedComments }, "removed comments while deleting story");
  } else if (calculateTotalCommentCount(story.commentCounts.status) > 0) {
    log.warn(
      "attempted to remove story that has linked comments without consent for deleting comments"
    );

    // TODO: (wyattjoh) improve error
    throw new Error("asset has comments, cannot remove");
  }

  const removedStory = await removeStory(mongo, tenant.id, story.id);
  if (!removedStory) {
    // Story was already removed.
    // TODO: evaluate use of transaction here.
    return null;
  }

  log.debug("removed story");

  return removedStory;
}

export type CreateStory = Omit<CreateStoryInput, "siteID">;

export async function create(
  mongo: Db,
  tenant: Tenant,
  broker: CoralEventPublisherBroker,
  config: Config,
  storyID: string,
  storyURL: string,
  { mode, metadata, closedAt }: CreateStory,
  now = new Date()
) {
  // Validate the mode if passed.
  if (mode) {
    validateStoryMode(tenant, mode);
  }

  // Validate the id.
  if (!storyID) {
    throw new Error("story id is required");
  }

  if (!storyURL) {
    throw new StoryURLInvalidError({ storyURL, tenantDomain: tenant.domain });
  }

  const site = await findSiteByURL(mongo, tenant.id, storyURL);
  if (!site) {
    throw new StoryURLInvalidError({ storyURL, tenantDomain: tenant.domain });
  }

  // Construct the input payload.
  const input: CreateStoryInput = { metadata, mode, closedAt, siteID: site.id };
  if (metadata) {
    input.scrapedAt = now;
  }

  // Create the story in the database.
  let story = await createStory(
    mongo,
    tenant.id,
    storyID,
    storyURL,
    input,
    now
  );
  if (!metadata && tenant.stories.scraping.enabled) {
    // If the scraper has not scraped this story and story metadata was not
    // provided, we need to scrape it now!
    story = await scrape(mongo, config, tenant.id, story.id, storyURL);
  }

  StoryCreatedCoralEvent.publish(broker, {
    storyID: story.id,
    storyURL: story.url,
    siteID: site.id,
  }).catch((err) => {
    logger.error({ err }, "could not publish story created event");
  });

  return story;
}

export type UpdateStory = UpdateStoryInput;

export async function update(
  mongo: Db,
  tenant: Tenant,
  storyID: string,
  input: UpdateStory,
  now = new Date()
) {
  if (input.url) {
    const site = await findSiteByURL(mongo, tenant.id, input.url);
    if (!site) {
      throw new StoryURLInvalidError({
        storyURL: input.url,
        tenantDomain: tenant.domain,
      });
    }
  }

  return updateStory(mongo, tenant.id, storyID, input, now);
}

function validateStoryMode(tenant: Tenant, mode: GQLSTORY_MODE) {
  if (mode === GQLSTORY_MODE.QA) {
    ensureFeatureFlag(tenant, GQLFEATURE_FLAG.ENABLE_QA);
  } else if (mode === GQLSTORY_MODE.RATINGS_AND_REVIEWS) {
    ensureFeatureFlag(tenant, GQLFEATURE_FLAG.ENABLE_RATINGS_AND_REVIEWS);
  }
}

export type UpdateStorySettings = UpdateStorySettingsInput;

export async function updateSettings(
  mongo: Db,
  tenant: Tenant,
  storyID: string,
  input: UpdateStorySettings,
  now = new Date()
) {
  // Validate the input mode.
  if (input.mode) {
    validateStoryMode(tenant, input.mode);
  }

  return updateStorySettings(mongo, tenant.id, storyID, input, now);
}

export async function open(
  mongo: Db,
  tenant: Tenant,
  storyID: string,
  now = new Date()
) {
  return openStory(mongo, tenant.id, storyID, now);
}

export async function close(
  mongo: Db,
  tenant: Tenant,
  storyID: string,
  now = new Date()
) {
  return closeStory(mongo, tenant.id, storyID, now);
}

export async function merge(
  mongo: Db,
  tenant: Tenant,
  destinationID: string,
  sourceIDs: string[]
) {
  // Create a logger for this operation.
  const log = logger.child({ destinationID, sourceIDs }, true);

  if (sourceIDs.length === 0) {
    log.warn("cannot merge from 0 stories");
    return null;
  }

  // Collect the story id's and check for duplicates.
  const storyIDs = [destinationID, ...sourceIDs];
  if (uniq(storyIDs).length !== storyIDs.length) {
    throw new Error("cannot merge from/to the same story ID");
  }

  // Get the stories referenced.
  const stories = await retrieveManyStories(mongo, tenant.id, storyIDs);
  if (!isNonNullArray(stories)) {
    throw new Error("cannot find all the stories");
  }

  // We can only merge stories if they are all on the same site.
  if (uniq(stories.map(({ siteID }) => siteID)).length > 1) {
    throw new Error("cannot merge stories on different sites");
  }

  // We can only merge stories with the comments mode so if any of them are not
  // comments, then error.
  if (
    stories.some(
      ({ settings }) =>
        resolveStoryMode(settings, tenant) !== GQLSTORY_MODE.COMMENTS
    )
  ) {
    throw new Error("cannot merge stories not in comments mode");
  }

  // Move all the comment's from the source stories over to the destination
  // story.
  const { modifiedCount: updatedComments } = await mergeManyCommentStories(
    mongo,
    tenant.id,
    destinationID,
    sourceIDs
  );

  log.debug({ updatedComments }, "updated comments while merging stories");

  // Update all the action's that referenced the old story to reference the new
  // story.
  const { modifiedCount: updatedActions } = await mergeManyStoryActions(
    mongo,
    tenant.id,
    destinationID,
    sourceIDs
  );

  log.debug({ updatedActions }, "updated actions while merging stories");

  // Merge the comment and action counts for all the source stories.
  const [, ...sourceStories] = stories;

  // Compute the new comment counts from the old stories.
  const commentCounts = {
    status: mergeCommentStatusCount(
      ...sourceStories.map((s) => s.commentCounts.status)
    ),
    moderationQueue: mergeCommentModerationQueueCount(
      ...sourceStories.map((s) => s.commentCounts.moderationQueue)
    ),
    action: mergeCommentActionCounts(
      ...sourceStories.map((s) => s.commentCounts.action)
    ),
  };

  // Update the story that was the destination of the merge.
  const destinationStory = await updateStoryCounts(
    mongo,
    tenant.id,
    destinationID,
    commentCounts
  );
  if (!destinationStory) {
    log.warn("destination story cannot be updated with new comment counts");
    return null;
  }

  log.debug(
    { commentCounts: destinationStory.commentCounts },
    "updated destination story with new comment counts"
  );

  // Remove the stories from MongoDB.
  const { deletedCount } = await removeStories(mongo, tenant.id, sourceIDs);

  log.debug({ deletedStories: deletedCount }, "deleted source stories");

  // Return the story that had the other stories merged into.
  return destinationStory;
}

export async function addExpert(
  mongo: Db,
  tenant: Tenant,
  storyID: string,
  userID: string
) {
  const user = await retrieveUser(mongo, tenant.id, userID);
  if (!user) {
    throw new UserNotFoundError(userID);
  }

  return addStoryExpert(mongo, tenant.id, storyID, userID);
}

export async function removeExpert(
  mongo: Db,
  tenant: Tenant,
  storyID: string,
  userID: string
) {
  const user = await retrieveUser(mongo, tenant.id, userID);
  if (!user) {
    throw new UserNotFoundError(userID);
  }

  return removeStoryExpert(mongo, tenant.id, storyID, userID);
}

export async function updateStoryMode(
  mongo: Db,
  tenant: Tenant,
  storyID: string,
  mode: GQLSTORY_MODE
) {
  // Validate the mode.
  validateStoryMode(tenant, mode);

  return setStoryMode(mongo, tenant.id, storyID, mode);
}

export async function retrieveSections(mongo: Db, tenant: Tenant) {
  if (!hasFeatureFlag(tenant, GQLFEATURE_FLAG.SECTIONS)) {
    return null;
  }

  return retrieveStorySections(mongo, tenant.id);
}

type LiveEnabledSource = Story | LiveConfiguration;

function sourceIsStory(source: LiveEnabledSource): source is Story {
  // All stories have an ID and a Tenant ID, if it has this it's a Story!
  if ((source as Story).id && (source as Story).tenantID) {
    return true;
  }

  return false;
}

export async function isLiveEnabled(
  config: Config,
  tenant: Tenant,
  source: LiveEnabledSource,
  now: Date
) {
  if (config.get("disable_live_updates")) {
    return false;
  }

  let settings: Partial<LiveConfiguration>;

  if (sourceIsStory(source)) {
    const timeout = config.get("disable_live_updates_timeout");
    if (timeout > 0) {
      // If one of these is available, use it to determine the time since the
      // last comment.
      const lastCommentedAt = source.lastCommentedAt || source.createdAt;

      // If this date is before the timeout...
      if (
        DateTime.fromJSDate(lastCommentedAt)
          .plus({
            milliseconds: timeout,
          })
          .toJSDate() <= now
      ) {
        // Then we know that the last comment (or lack there of) was left more
        // than the timeout specified in configuration.
        return false;
      }
    }

    // If the live settings aren't set on the Story, then default to the
    // organization setting.
    if (!source.settings.live) {
      return tenant.live.enabled;
    }

    // Live settings are available, set them on the settings object.
    settings = source.settings.live;
  } else {
    // The source wasn't a story, but settings!
    settings = source;
  }

  // If the settings don't have the setting property enabled, then use the
  // tenant settings.
  return defaultTo(settings.enabled, tenant.live.enabled);
}
