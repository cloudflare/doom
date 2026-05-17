import {
  CloudflareTransparentIcon,
  BrowserRunIcon,
  D1Icon,
  WorkersAIIcon,
  R2Icon,
  DOIcon,
  WorkflowsIcon,
  EmailIcon,
  QueuesIcon,
  AgentsSDKIcon,
} from "./Icons";

export const Products = () => {
  return (
    <div id="products">
      <div className="product">
        <CloudflareTransparentIcon />
      </div>
      <div className="product">
        <BrowserRunIcon />
        <div className="product-lines">
          <p>Browser</p>
          <p>Run</p>
        </div>
      </div>
      <div className="product">
        <D1Icon />
        <div className="product-lines">
          <p>D1</p>
        </div>
      </div>
      <div className="product">
        <WorkersAIIcon />
        <div className="product-lines">
          <p>Workers</p>
          <p>AI</p>
        </div>
      </div>
      <div className="product">
        <R2Icon />
        <div className="product-lines">
          <p>R2</p>
        </div>
      </div>
      <div className="product">
        <DOIcon />
        <div className="product-lines">
          <p>Durable</p>
          <p>Objects</p>
        </div>
      </div>
      <div className="product">
        <WorkflowsIcon />
        <div className="product-lines">
          <p>Workflows</p>
        </div>
      </div>
      <div className="product">
        <EmailIcon />
        <div className="product-lines">
          <p>Email</p>
          <p>Service</p>
        </div>
      </div>
      <div className="product">
        <QueuesIcon />
        <div className="product-lines">
          <p>Queues</p>
        </div>
      </div>
      <div className="product">
        <AgentsSDKIcon />
        <div className="product-lines">
          <p>Agents</p>
          <p>SDK</p>
        </div>
      </div>
    </div>
  );
};
