import { pick } from "lodash";
import { graphql } from "react-relay";
import { Environment } from "relay-runtime";

import {
  commitMutationPromiseNormalized,
  createMutationContainer,
  MutationInput,
  MutationResponsePromise,
} from "coral-framework/lib/relay";

import { EditCommentMutation as MutationTypes } from "coral-stream/__generated__/EditCommentMutation.graphql";

export type EditCommentInput = MutationInput<MutationTypes>;

const mutation = graphql`
  mutation EditCommentMutation($input: EditCommentInput!) {
    editComment(input: $input) {
      comment {
        body
        status
        revision {
          id
        }
        editing {
          edited
        }
      }
      clientMutationId
    }
  }
`;

let clientMutationId = 0;

function commit(environment: Environment, input: EditCommentInput) {
  return commitMutationPromiseNormalized<MutationTypes>(environment, {
    mutation,
    variables: {
      input: {
        ...pick(input, ["commentID", "body"]),
        clientMutationId: clientMutationId.toString(),
      },
    },
    optimisticResponse: {
      editComment: {
        id: input.commentID,
        body: input.body,
        editing: {
          edited: true,
        },
        clientMutationId: (clientMutationId++).toString(),
      },
    },
    updater: store => {
      store.get(input.commentID)!.setValue("EDIT", "lastViewerAction");
    },
  });
}

export const withEditCommentMutation = createMutationContainer(
  "editComment",
  commit
);

export type EditCommentMutation = (
  input: EditCommentInput
) => MutationResponsePromise<MutationTypes, "editComment">;